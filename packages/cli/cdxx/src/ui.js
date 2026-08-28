import { confirm, input, select } from "@inquirer/prompts";
import {
  pickAgentProfileAction,
  agentCliManifests,
  relativeTime,
  renderAgentProfileTable,
} from "@dong-/agentx-core";
import { codexQuotaScopes, formatReset } from "./quota.js";
import { exhaustedQuotaScopes, profileSelectableReason } from "./selection.js";

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

export function profilePresentationRows(state) {
  return profileRows(state).map((row) => ({
    id: row.profile.name,
    active: row.marker === "*",
    selectable: row.selectable,
    muted: row.status !== "ready" && row.status !== "unknown",
    disabledReason: row.disabledReason,
    cells: {
      marker: row.marker || " ",
      number: row.number,
      name: row.name,
      expectedEmail: row.expectedEmail,
      actualEmail: row.actualEmail,
      status: row.status,
      quotaReset: row.quotaReset,
      lastRequest: row.lastRequest,
      activated: row.activated,
      verified: row.verified,
      switches: row.switches,
    },
  }));
}

export function printProfiles(state) {
  console.log(renderAgentProfileTable(profilePresentationRows(state)));
}

export async function pickProfileAction(state, mode, notice) {
  return await pickAgentProfileAction({
    rows: profilePresentationRows(state),
    mode,
    notice,
    default: state.activeProfile,
    capabilities: { delete: true, rename: true },
  });
}

export async function pickProfileForUse(state) {
  const action = await pickProfileAction(state, "use");
  if (action.type === "select") return action.name;
  throw new Error("No profile selected.");
}

export async function confirmAction(message, defaultValue = false) {
  return await confirm({ message, default: defaultValue });
}

export async function promptText(message, defaultValue) {
  return await input({ message, default: defaultValue });
}

export async function pickConfigKey(settings) {
  return await select({
    message: "Select setting",
    choices: [
      {
        name: `autoswitch  ${settings.autoSwitchMode ?? (settings.autoswitch ? "scope-first" : "off")}`,
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
  const values = key === "autoswitch"
    ? agentCliManifests.codex.quotaFailover.supportedAutoSwitchModes
    : ["on", "off"];
  return await select({
    message: `Select value for ${key}`,
    choices: values.map((value) => ({
      name: value,
      value,
      description: current === value ? "current" : undefined,
    })),
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
