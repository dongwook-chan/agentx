import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runUsageCheck } from "@dong-/agentx-core";
import { codexHome, clearExpiredQuota, loadState, saveState } from "./config.js";
import { probeCodexStatusQuota } from "./status_probe.js";

export const sessionsDir = join(codexHome, "sessions");
export const codexQuotaScopes = {
  primary: "5h",
  secondary: "weekly",
  monthly: "monthly",
  unknown: "unknown",
};

const statusLimitScopes = [
  { key: "primary", scope: codexQuotaScopes.primary, label: "5h", reasonLabel: "primary" },
  { key: "secondary", scope: codexQuotaScopes.secondary, label: "weekly", reasonLabel: "secondary" },
  { key: "monthly", scope: codexQuotaScopes.monthly, label: "monthly", reasonLabel: "monthly" },
];

async function walkJsonl(dir, out = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

function epochSecondsToIso(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
}

function pickReset(rateLimits) {
  const primary = rateLimits?.primary;
  const secondary = rateLimits?.secondary;
  if (primary?.used_percent >= 100) return epochSecondsToIso(primary.resets_at);
  if (secondary?.used_percent >= 100) return epochSecondsToIso(secondary.resets_at);
  return epochSecondsToIso(primary?.resets_at) ?? epochSecondsToIso(secondary?.resets_at);
}

function numericPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function creditsExhausted(rateLimits) {
  const credits = rateLimits?.credits;
  if (!credits || typeof credits !== "object") return false;
  if (rateLimits.limit_id !== "premium" && (rateLimits.primary || rateLimits.secondary)) return false;
  if (credits.unlimited === true) return false;
  if (credits.has_credits === true) return false;
  if (credits.has_credits !== false) return false;
  const balance = typeof credits.balance === "number"
    ? credits.balance
    : Number.parseFloat(String(credits.balance ?? ""));
  return Number.isFinite(balance) && balance <= 0;
}

export function createQuotaSummary() {
  return {
    source: "jsonl",
    scannedFiles: 0,
    tokenCountRecords: 0,
    maxPrimary: 0,
    maxSecondary: 0,
    maxMonthly: 0,
    firstAt: undefined,
    lastAt: undefined,
    planType: undefined,
    lastCredits: undefined,
    exhausted: false,
    historicalExhausted: false,
    exhaustedEvents: 0,
    reason: undefined,
    resetAt: undefined,
    reachedTypes: new Set(),
    current: undefined,
    highWatermarks: [],
  };
}

function limitValue(status, name, key) {
  const value = status?.limits?.[name]?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function statusReason(status) {
  for (const { key, reasonLabel } of statusLimitScopes) {
    const remaining = limitValue(status, key, "remainingPercent");
    if (remaining !== undefined && remaining <= 0) return `${reasonLabel} status limit reached`;
  }
  return undefined;
}

function statusResetAt(status, exhausted) {
  if (!exhausted) return undefined;
  for (const { key } of statusLimitScopes) {
    const remaining = limitValue(status, key, "remainingPercent");
    if (remaining !== undefined && remaining <= 0) return status.limits?.[key]?.resetAt;
  }
  for (const { key } of statusLimitScopes) {
    const resetAt = status.limits?.[key]?.resetAt;
    if (resetAt) return resetAt;
  }
  return undefined;
}

function quotaScopeRecord({ status, usedPercent, remainingPercent, resetAt, resetText, reason, checkedAt }) {
  return {
    status,
    usedPercent,
    remainingPercent,
    resetAt,
    resetText,
    reason,
    checkedAt,
  };
}

export function createQuotaSummaryFromStatus(status, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const used = Object.fromEntries(statusLimitScopes.map(({ key }) => [key, limitValue(status, key, "usedPercent")]));
  const remaining = Object.fromEntries(statusLimitScopes.map(({ key }) => [key, limitValue(status, key, "remainingPercent")]));
  const resetText = Object.fromEntries(statusLimitScopes.map(({ key }) => [key, status.limits?.[key]?.resetText]));
  const resetAtByScope = Object.fromEntries(statusLimitScopes.map(({ key }) => [key, status.limits?.[key]?.resetAt]));
  const exhausted = statusLimitScopes.some(({ key }) => remaining[key] !== undefined && remaining[key] <= 0);
  const reason = statusReason(status);
  const resetAt = statusResetAt(status, exhausted);
  const highWater = statusLimitScopes.some(({ key }) => used[key] >= 90);
  const highWatermarks = highWater || exhausted
    ? [{
      file: undefined,
      line: undefined,
      timestamp: now,
      primary: used.primary,
      secondary: used.secondary,
      monthly: used.monthly,
      reachedType: undefined,
      resetAt,
      credits: undefined,
    }]
    : [];

  return {
    source: "status",
    scannedFiles: 0,
    tokenCountRecords: 0,
    statusRecords: 1,
    maxPrimary: used.primary ?? 0,
    maxSecondary: used.secondary ?? 0,
    maxMonthly: used.monthly ?? 0,
    firstAt: now,
    lastAt: now,
    planType: status.planType,
    account: status.account,
    sessionId: status.sessionId,
    lastCredits: undefined,
    exhausted,
    historicalExhausted: exhausted,
    exhaustedEvents: exhausted ? 1 : 0,
    reason,
    resetAt,
    reachedTypes: [],
    statusRemaining: remaining,
    statusResetText: resetText,
    statusResetAt: resetAtByScope,
    current: {
      file: undefined,
      line: undefined,
      timestamp: now,
      primary: used.primary,
      secondary: used.secondary,
      monthly: used.monthly,
      reachedType: undefined,
      resetAt,
      resetAtByScope,
      credits: undefined,
      planType: status.planType,
    },
    highWatermarks,
  };
}

export function quotaScopesFromSummary(summary) {
  if (!summary?.current) return undefined;
  const checkedAt = summary.lastAt ?? summary.current.timestamp ?? new Date().toISOString();
  if (
    summary.exhausted
    && statusLimitScopes.every(({ key }) => summary.current[key] === undefined)
  ) {
    return {
      [codexQuotaScopes.unknown]: quotaScopeRecord({
        status: "exhausted",
        usedPercent: undefined,
        remainingPercent: undefined,
        resetAt: summary.resetAt,
        resetText: undefined,
        reason: summary.reason ?? "quota exhausted",
        checkedAt,
      }),
    };
  }
  const scopes = {};
  for (const { key, scope, label } of statusLimitScopes) {
    const current = summary.current[key];
    const remaining = summary.statusRemaining?.[key]
      ?? (typeof current === "number" ? Math.max(0, 100 - current) : undefined);
    const hasScope = current !== undefined
      || remaining !== undefined
      || summary.statusResetText?.[key] !== undefined
      || summary.statusResetAt?.[key] !== undefined
      || summary.current.resetAtByScope?.[key] !== undefined;
    if (!hasScope) continue;
    const exhausted = remaining !== undefined ? remaining <= 0 : current >= 100;
    const resetAt = summary.statusResetAt?.[key]
      ?? summary.current.resetAtByScope?.[key]
      ?? (exhausted ? summary.current.resetAt : undefined);
    scopes[scope] = quotaScopeRecord({
      status: exhausted ? "exhausted" : "available",
      usedPercent: current,
      remainingPercent: remaining,
      resetAt,
      resetText: summary.statusResetText?.[key],
      reason: exhausted ? `${label} quota exhausted` : undefined,
      checkedAt,
    });
  }
  return Object.keys(scopes).length ? scopes : undefined;
}

function updateSummary(summary, file, lineNumber, event) {
  const rateLimits = event.payload?.rate_limits;
  if (!rateLimits) return;
  const primary = numericPercent(rateLimits.primary?.used_percent);
  const secondary = numericPercent(rateLimits.secondary?.used_percent);
  const reachedType = rateLimits.rate_limit_reached_type ?? null;
  const outOfCredits = creditsExhausted(rateLimits);
  const timestamp = event.timestamp;

  summary.tokenCountRecords += 1;
  if (primary !== undefined) summary.maxPrimary = Math.max(summary.maxPrimary, primary);
  if (secondary !== undefined) summary.maxSecondary = Math.max(summary.maxSecondary, secondary);
  if (!summary.firstAt || timestamp < summary.firstAt) summary.firstAt = timestamp;
  if (!summary.lastAt || timestamp > summary.lastAt) {
    summary.lastAt = timestamp;
    summary.current = {
      file,
      line: lineNumber,
      timestamp,
      primary,
      secondary,
      monthly: undefined,
      reachedType,
      limitId: rateLimits.limit_id,
      resetAt: pickReset(rateLimits),
      resetAtByScope: {
        primary: epochSecondsToIso(rateLimits.primary?.resets_at),
        secondary: epochSecondsToIso(rateLimits.secondary?.resets_at),
        monthly: undefined,
      },
      credits: rateLimits.credits,
      planType: rateLimits.plan_type,
    };
  }
  if (rateLimits.credits) summary.lastCredits = rateLimits.credits;
  if (rateLimits.plan_type) summary.planType = rateLimits.plan_type;
  if (reachedType) summary.reachedTypes.add(String(reachedType));

  const exhausted = primary >= 100 || secondary >= 100 || reachedType !== null || outOfCredits;
  if (primary >= 90 || secondary >= 90 || exhausted) {
    summary.highWatermarks.push({
      file,
      line: lineNumber,
      timestamp,
      primary,
      secondary,
      monthly: undefined,
      reachedType,
      resetAt: pickReset(rateLimits),
      credits: rateLimits.credits,
    });
  }
  if (exhausted) {
    summary.historicalExhausted = true;
    summary.exhaustedEvents += 1;
    summary.resetAt = pickReset(rateLimits) ?? summary.resetAt;
    summary.reason = reachedType ? `rate_limit_reached_type=${reachedType}` : (
      outOfCredits ? "credits exhausted" : (primary >= 100 ? "primary rate limit reached" : "secondary rate limit reached")
    );
  }
}

export function ingestQuotaLine(summary, file, lineNumber, line) {
  if (!line.includes("\"token_count\"") || !line.includes("\"rate_limits\"")) return false;
  try {
    const event = JSON.parse(line);
    if (event.type === "event_msg" && event.payload?.type === "token_count") {
      updateSummary(summary, file, lineNumber, event);
      return true;
    }
  } catch {
    // Ignore partial or malformed JSONL records.
  }
  return false;
}

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

export function parseQuotaTriggerLine(line) {
  if (!/(usage limit|purchase more credits|upgrade to pro|try again at)/i.test(line)) return undefined;
  let text = line;
  let timestamp;
  try {
    const event = JSON.parse(line);
    timestamp = event.timestamp;
    text = collectStrings(event.payload ?? event).join("\n");
  } catch {
    // Plain text lines can still be used as a wake-up trigger.
  }
  const hitUsageLimit = /you(?:'|’)?ve hit your usage limit/i.test(text);
  const purchaseCredits = /purchase more credits/i.test(text);
  const retryLater = /try again at\s+[^.\n]+/i.test(text);
  if (!hitUsageLimit && !purchaseCredits && !retryLater) return undefined;
  return {
    type: "usage_limit_message",
    timestamp,
    reason: hitUsageLimit ? "usage limit reached" : "quota warning",
  };
}

export function finalizeQuotaSummary(summary, nowMs = Date.now()) {
  const reachedTypes = summary.reachedTypes instanceof Set
    ? [...summary.reachedTypes]
    : (summary.reachedTypes ?? []);
  summary.reachedTypes = reachedTypes;
  const currentResetMs = summary.current?.resetAt ? Date.parse(summary.current.resetAt) : undefined;
  const currentResetActive = currentResetMs === undefined || currentResetMs > nowMs;
  summary.exhausted = Boolean(
    summary.current
    && currentResetActive
    && (
      summary.current.primary >= 100
      || summary.current.secondary >= 100
      || summary.current.reachedType !== null
      || creditsExhausted({
        limit_id: summary.current.limitId,
        primary: summary.current.primary === undefined ? null : {},
        secondary: summary.current.secondary === undefined ? null : {},
        credits: summary.current.credits,
      })
    ),
  );
  if (summary.exhausted) {
    summary.reason = summary.current.reachedType
      ? `rate_limit_reached_type=${summary.current.reachedType}`
      : (creditsExhausted({
        limit_id: summary.current.limitId,
        primary: summary.current.primary === undefined ? null : {},
        secondary: summary.current.secondary === undefined ? null : {},
        credits: summary.current.credits,
      })
        ? "credits exhausted"
        : (summary.current.primary >= 100 ? "primary rate limit reached" : "secondary rate limit reached"));
    summary.resetAt = summary.current.resetAt;
  }
  return summary;
}

export async function scanCodexSessions(options = {}) {
  const sinceMs = options.sinceMs ?? 0;
  const files = await walkJsonl(options.sessionsDir ?? sessionsDir);
  const summary = createQuotaSummary();

  for (const file of files) {
    const info = await stat(file).catch(() => undefined);
    if (!info || info.mtimeMs < sinceMs) continue;
    summary.scannedFiles += 1;
    const content = await readFile(file, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      ingestQuotaLine(summary, file, index + 1, lines[index]);
    }
  }

  return finalizeQuotaSummary(summary);
}

export async function scanCodexQuota(options = {}) {
  if (options.preferStatus === false) return await scanCodexSessions(options);
  // Codex /status can briefly lag just after a fresh TUI starts or after a
  // quota event. Live exhaustion is still triggered from session logs; /status
  // is the preferred refresh source for current windows and resetAt when it is
  // available.
  const adapter = {
    refreshUsage: async () => {
      const status = options.status ?? await probeCodexStatusQuota(options.statusOptions ?? {});
      return status ? createQuotaSummaryFromStatus(status, options.nowMs) : undefined;
    },
    scanLocalUsage: async () => await scanCodexSessions(options),
  };
  const summary = await runUsageCheck(adapter, options.reason ?? "explicit-scan", {
    allowLocalFallback: options.allowLocalFallback ?? true,
  });
  if (summary?.refreshError) summary.statusProbeError = summary.refreshError;
  return summary ?? createQuotaSummary();
}

export async function recordQuotaForProfile(summary, profileName) {
  const state = await loadState();
  const profile = state.profiles.find((entry) => entry.name === profileName);
  if (!profile) return undefined;
  clearExpiredQuota(profile);
  const now = new Date().toISOString();
  profile.lastScanAt = now;
  profile.lastUsage = {
    source: summary.source,
    maxPrimary: summary.maxPrimary,
    maxSecondary: summary.maxSecondary,
    maxMonthly: summary.maxMonthly,
    statusRemaining: summary.statusRemaining,
    statusResetAt: summary.statusResetAt,
    statusResetText: summary.statusResetText,
    planType: summary.planType,
    lastAt: summary.lastAt,
    credits: summary.lastCredits,
  };
  const quotaScopes = quotaScopesFromSummary(summary);
  if (quotaScopes) profile.quotaScopes = quotaScopes;
  if (summary.exhausted) {
    profile.quotaStatus = "exhausted";
    profile.quotaResetAt = summary.resetAt;
    profile.lastQuotaReason = summary.reason;
    profile.lastQuotaErrorAt = summary.lastAt ?? now;
  } else if (summary.tokenCountRecords > 0 || summary.source === "status") {
    profile.quotaStatus = "available";
    profile.quotaResetAt = undefined;
    profile.lastQuotaReason = undefined;
  }
  profile.updatedAt = now;
  await saveState(state);
  return profile;
}

export async function recordQuotaForActiveProfile(summary) {
  const state = await loadState();
  if (!state.activeProfile) return undefined;
  return await recordQuotaForProfile(summary, state.activeProfile);
}

export function formatReset(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return iso;
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}
