import { confirm, select } from "@inquirer/prompts";
import {
  agentProfileTableHeaders,
  decideUseProfile,
  relativeTime,
  useProfileDisabledReason,
} from "@dong-/agentx-core";
import Table from "cli-table3";
import { codexQuotaScopes, formatReset } from "./quota.js";
import { exhaustedQuotaScopes, profileSelectableReason } from "./selection.js";

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function profileStatus(profile) {
  if (profile.disabled) return "disabled";
  const exhausted = exhaustedQuotaScopes(profile);
  if (exhausted.length) return exhausted.includes(codexQuotaScopes.unknown)
    ? "quota"
    : `quota:${exhausted.join(",")}`;
  if (profile.quotaStatus === "exhausted") return "quota";
  return profile.quotaStatus === "available" ? "ready" : (profile.quotaStatus ?? "unknown");
}

function profileReset(profile) {
  const resets = Object.values(profile.quotaScopes ?? {})
    .filter((quota) => quota?.resetAt)
    .map((quota) => quota.resetAt)
    .sort();
  return formatReset(resets[0] ?? profile.quotaResetAt);
}

function profileRows(state) {
  return state.profiles.map((profile, index) => ({
    marker: state.activeProfile === profile.name ? "*" : "",
    number: String(index + 1),
    name: profile.name,
    expectedEmail: profile.email ?? profile.accountId ?? "-",
    actualEmail: profile.email ?? profile.accountId ?? "-",
    status: profileStatus(profile),
    quotaReset: profileReset(profile) || "-",
    lastRequest: relativeTime(profile.lastUsage?.lastAt ?? profile.lastSession?.matchedAt),
    activated: relativeTime(profile.lastActivatedAt),
    verified: relativeTime(profile.updatedAt),
    switches: String(profile.selectionCount ?? 0),
    selectable: !profileSelectableReason(profile),
    disabledReason: profileSelectableReason(profile),
    profile,
  }));
}

function profileCells(row) {
  return [
    row.marker,
    row.number,
    row.name,
    row.expectedEmail,
    row.actualEmail,
    row.status,
    row.quotaReset,
    row.lastRequest,
    row.activated,
    row.verified,
    row.switches,
  ];
}

export function printProfiles(state) {
  if (!state.profiles.length) {
    console.log("No saved profiles.");
    return;
  }
  const table = new Table({
    head: [...agentProfileTableHeaders],
    colAligns: ["center", "right", "left", "left", "left", "left", "left", "left", "left", "left", "right"],
    style: { head: [], border: [] },
    wordWrap: false,
  });
  for (const row of profileRows(state)) {
    table.push(profileCells(row));
  }
  console.log(table.toString());
}

function selectableReason(profile) {
  return profileSelectableReason(profile);
}

function useCandidates(state) {
  return state.profiles.map((profile) => {
    const reason = selectableReason(profile);
    return {
      name: profile.name,
      active: state.activeProfile === profile.name,
      selectable: !reason,
      disabledReason: reason,
    };
  });
}

function profileChoiceLabel(profile, state) {
  const row = profileRows(state).find((entry) => entry.profile === profile);
  return row ? profileCells(row).map((value, index) => pad(value || " ", Math.max(agentProfileTableHeaders[index].length, String(value || "").length))).join("  ") : profile.name;
}

export async function pickProfileForUse(state) {
  const candidates = useCandidates(state);
  const decision = decideUseProfile(candidates);
  if (decision.type === "empty") throw new Error(decision.message);
  const candidatesByName = new Map(decision.candidates.map((candidate) => [candidate.name, candidate]));
  const choices = state.profiles.map((profile) => {
    const candidate = candidatesByName.get(profile.name);
    const reason = candidate ? useProfileDisabledReason(candidate) : "not selectable";
    return {
      name: reason ? `${profileChoiceLabel(profile, state)}  (${reason})` : profileChoiceLabel(profile, state),
      value: profile.name,
      description: reason,
    };
  });
  return await select({
    message: `Select profile\n  ${agentProfileTableHeaders.join("  ")}`,
    choices,
    pageSize: 7,
    loop: true,
  });
}

export async function confirmProfileUse(profile, reason) {
  return await confirm({
    message: `Profile '${profile.name}' is marked ${reason}. Switch anyway?`,
    default: false,
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
    const scopes = [
      ["5h", "primary"],
      ["weekly", "secondary"],
      ["monthly", "monthly"],
    ];
    for (const [label, key] of scopes) {
      const used = summary.current[key];
      const left = summary.statusRemaining?.[key];
      if (used === undefined && left === undefined) continue;
      console.log(`current ${label}: ${used ?? "-"}%${left === undefined ? "" : ` used (${left}% left)`}`);
    }
  }
  if (summary.maxPrimary !== undefined) console.log(`historical max 5h: ${summary.maxPrimary}%`);
  if (summary.maxSecondary !== undefined) console.log(`historical max weekly: ${summary.maxSecondary}%`);
  if (summary.maxMonthly !== undefined) console.log(`historical max monthly: ${summary.maxMonthly}%`);
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
      const parts = [];
      if (event.primary !== undefined) parts.push(`5h=${event.primary}%`);
      if (event.secondary !== undefined) parts.push(`weekly=${event.secondary}%`);
      if (event.monthly !== undefined) parts.push(`monthly=${event.monthly}%`);
      console.log(`${event.timestamp} ${parts.join(" ")} ${location}`);
    }
  }
}
