import { select } from "@inquirer/prompts";
import {
  decideUseProfile,
  useProfileDisabledReason,
} from "@dong-/agentx-core";
import { codexQuotaScopes, formatReset } from "./quota.js";

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function activeQuotaScopes(profile) {
  return Object.entries(profile.quotaScopes ?? {})
    .filter(([, quota]) => quota?.status === "exhausted")
    .map(([scope]) => scope);
}

function profileStatus(profile) {
  if (profile.disabled) return "disabled";
  const exhausted = activeQuotaScopes(profile);
  if (exhausted.length) return `quota:${exhausted.join(",")}`;
  return profile.quotaStatus === "available" ? "available" : (profile.quotaStatus ?? "unknown");
}

function profileReset(profile) {
  const resets = Object.values(profile.quotaScopes ?? {})
    .filter((quota) => quota?.status === "exhausted" && quota.resetAt)
    .map((quota) => quota.resetAt)
    .sort();
  return formatReset(resets[0] ?? profile.quotaResetAt);
}

function quotaCell(profile, scope, fallbackUsed) {
  const quota = profile.quotaScopes?.[scope];
  const used = quota ? quota.usedPercent : fallbackUsed;
  const remaining = quota?.remainingPercent;
  if (used === undefined && remaining === undefined) return "";
  if (remaining !== undefined) return `${remaining}% left`;
  return `${used}%`;
}

export function printProfiles(state) {
  if (!state.profiles.length) {
    console.log("No saved profiles.");
    return;
  }
  const rows = state.profiles.map((profile) => ({
    active: state.activeProfile === profile.name ? "*" : "",
    name: profile.name,
    email: profile.email ?? profile.accountId ?? "",
    status: profileStatus(profile),
    reset: profileReset(profile),
    fiveHour: quotaCell(profile, codexQuotaScopes.primary, profile.lastUsage?.maxPrimary),
    weekly: quotaCell(profile, codexQuotaScopes.secondary, profile.lastUsage?.maxSecondary),
    selected: profile.selectionCount ?? 0,
  }));
  const headers = ["", "name", "account", "status", "reset", "5h", "weekly", "switches"];
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(Object.values(row)[index] ?? "").length),
  ));
  console.log(headers.map((header, index) => pad(header, widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(Object.values(row).map((value, index) => pad(value, widths[index])).join("  "));
  }
}

function selectableReason(profile, state) {
  if (profile.disabled) return "disabled";
  const exhausted = activeQuotaScopes(profile);
  if (exhausted.length) return `quota exhausted: ${exhausted.join(",")}`;
  if (profile.quotaStatus === "exhausted") return "quota exhausted";
  return undefined;
}

function useCandidates(state) {
  return state.profiles.map((profile) => {
    const reason = selectableReason(profile, state);
    return {
      name: profile.name,
      active: state.activeProfile === profile.name,
      selectable: !reason,
      disabledReason: reason,
    };
  });
}

function profileChoiceLabel(profile, state) {
  const marker = state.activeProfile === profile.name ? "*" : " ";
  const account = profile.email ?? profile.accountId ?? "";
  const status = profileStatus(profile);
  const reset = profileReset(profile);
  return [
    marker,
    profile.name,
    account,
    status,
    reset,
    quotaCell(profile, codexQuotaScopes.primary, profile.lastUsage?.maxPrimary)
      ? `5h=${quotaCell(profile, codexQuotaScopes.primary, profile.lastUsage?.maxPrimary)}`
      : "",
    quotaCell(profile, codexQuotaScopes.secondary, profile.lastUsage?.maxSecondary)
      ? `weekly=${quotaCell(profile, codexQuotaScopes.secondary, profile.lastUsage?.maxSecondary)}`
      : "",
  ].filter(Boolean).join("  ");
}

export async function pickProfileForUse(state) {
  const candidates = useCandidates(state);
  const decision = decideUseProfile(candidates);
  if (decision.type === "empty") throw new Error(decision.message);
  if (decision.type === "none") {
    console.log(decision.message);
    return undefined;
  }
  const candidatesByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  const choices = state.profiles.map((profile) => {
    const candidate = candidatesByName.get(profile.name);
    const reason = candidate ? useProfileDisabledReason(candidate) : "not selectable";
    return {
      name: profileChoiceLabel(profile, state),
      value: profile.name,
      disabled: reason,
    };
  });
  return await select({
    message: "Select profile",
    choices,
    pageSize: 7,
    loop: true,
  });
}

export async function pickConfigKey(settings) {
  return await select({
    message: "Select setting",
    choices: [
      {
        name: `autoswitch  ${settings.autoswitch ? "on" : "off"}`,
        value: "autoswitch",
        description: "Switch profiles automatically when quota is exhausted.",
      },
      {
        name: `yolo        ${settings.yolo ? "on" : "off"}`,
        value: "yolo",
        description: "Launch Codex with approvals and sandbox bypassed.",
      },
    ],
    loop: true,
  });
}

export async function pickConfigValue(key, current) {
  return await select({
    message: `Select value for ${key}`,
    choices: [
      { name: "on", value: "on", description: current === true ? "current" : undefined },
      { name: "off", value: "off", description: current === false ? "current" : undefined },
    ],
    loop: true,
  });
}

export function printScanSummary(summary) {
  console.log(`source: ${summary.source ?? "jsonl"}`);
  if (summary.statusProbeError) console.log(`status probe: failed (${summary.statusProbeError}); used jsonl fallback`);
  if (summary.account) console.log(`account: ${summary.account}`);
  console.log(`files: ${summary.scannedFiles}`);
  console.log(`token_count records: ${summary.tokenCountRecords}`);
  if (summary.current) {
    const primaryLeft = summary.statusRemaining?.primary;
    const secondaryLeft = summary.statusRemaining?.secondary;
    console.log(`current 5h: ${summary.current.primary}%${primaryLeft === undefined ? "" : ` used (${primaryLeft}% left)`}`);
    console.log(`current weekly: ${summary.current.secondary}%${secondaryLeft === undefined ? "" : ` used (${secondaryLeft}% left)`}`);
  }
  console.log(`historical max 5h: ${summary.maxPrimary}%`);
  console.log(`historical max weekly: ${summary.maxSecondary}%`);
  if (summary.planType) console.log(`plan: ${summary.planType}`);
  if (summary.lastCredits) {
    console.log(`credits: has=${summary.lastCredits.has_credits ?? ""} balance=${summary.lastCredits.balance ?? ""}`);
  }
  console.log(`currently exhausted: ${summary.exhausted ? "yes" : "no"}`);
  console.log(`historical exhausted events: ${summary.exhaustedEvents}`);
  if (summary.exhausted && summary.reason) console.log(`reason: ${summary.reason}`);
  if (summary.exhausted && summary.resetAt) console.log(`reset: ${summary.resetAt} (${formatReset(summary.resetAt)})`);
  const recent = summary.highWatermarks.slice(-8);
  if (recent.length) {
    console.log("");
    console.log("recent high-water marks:");
    for (const event of recent) {
      const location = event.file ? `${event.file}:${event.line}` : (summary.source ?? "quota");
      console.log(`${event.timestamp} 5h=${event.primary}% weekly=${event.secondary}% ${location}`);
    }
  }
}
