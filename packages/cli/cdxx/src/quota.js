import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runUsageCheck } from "@dong-/agentx-core";
import { codexHome, clearExpiredQuota, loadState, saveState } from "./config.js";
import { probeCodexStatusQuota } from "./status_probe.js";

export const sessionsDir = join(codexHome, "sessions");
export const codexQuotaScopes = {
  primary: "5h",
  secondary: "weekly",
};

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

export function createQuotaSummary() {
  return {
    source: "jsonl",
    scannedFiles: 0,
    tokenCountRecords: 0,
    maxPrimary: 0,
    maxSecondary: 0,
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
  const primaryRemaining = limitValue(status, "primary", "remainingPercent");
  const secondaryRemaining = limitValue(status, "secondary", "remainingPercent");
  if (primaryRemaining !== undefined && primaryRemaining <= 0) return "primary status limit reached";
  if (secondaryRemaining !== undefined && secondaryRemaining <= 0) return "secondary status limit reached";
  return undefined;
}

function statusResetAt(status, exhausted) {
  if (!exhausted) return undefined;
  const primaryRemaining = limitValue(status, "primary", "remainingPercent");
  const secondaryRemaining = limitValue(status, "secondary", "remainingPercent");
  if (primaryRemaining !== undefined && primaryRemaining <= 0) return status.limits.primary?.resetAt;
  if (secondaryRemaining !== undefined && secondaryRemaining <= 0) return status.limits.secondary?.resetAt;
  return status.limits.primary?.resetAt ?? status.limits.secondary?.resetAt;
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
  const primary = limitValue(status, "primary", "usedPercent") ?? 0;
  const secondary = limitValue(status, "secondary", "usedPercent") ?? 0;
  const primaryRemaining = limitValue(status, "primary", "remainingPercent");
  const secondaryRemaining = limitValue(status, "secondary", "remainingPercent");
  const exhausted = Boolean(
    (primaryRemaining !== undefined && primaryRemaining <= 0)
    || (secondaryRemaining !== undefined && secondaryRemaining <= 0),
  );
  const reason = statusReason(status);
  const resetAt = statusResetAt(status, exhausted);
  const highWatermarks = primary >= 90 || secondary >= 90 || exhausted
    ? [{
      file: undefined,
      line: undefined,
      timestamp: now,
      primary,
      secondary,
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
    maxPrimary: primary,
    maxSecondary: secondary,
    firstAt: now,
    lastAt: now,
    planType: status.planType,
    account: status.account,
    lastCredits: undefined,
    exhausted,
    historicalExhausted: exhausted,
    exhaustedEvents: exhausted ? 1 : 0,
    reason,
    resetAt,
    reachedTypes: [],
    statusRemaining: {
      primary: primaryRemaining,
      secondary: secondaryRemaining,
    },
    statusResetText: {
      primary: status.limits?.primary?.resetText,
      secondary: status.limits?.secondary?.resetText,
    },
    statusResetAt: {
      primary: status.limits?.primary?.resetAt,
      secondary: status.limits?.secondary?.resetAt,
    },
    current: {
      file: undefined,
      line: undefined,
      timestamp: now,
      primary,
      secondary,
      reachedType: undefined,
      resetAt,
      credits: undefined,
      planType: status.planType,
    },
    highWatermarks,
  };
}

export function quotaScopesFromSummary(summary) {
  if (!summary?.current) return undefined;
  const checkedAt = summary.lastAt ?? summary.current.timestamp ?? new Date().toISOString();
  const primaryRemaining = summary.statusRemaining?.primary
    ?? (typeof summary.current.primary === "number" ? Math.max(0, 100 - summary.current.primary) : undefined);
  const secondaryRemaining = summary.statusRemaining?.secondary
    ?? (typeof summary.current.secondary === "number" ? Math.max(0, 100 - summary.current.secondary) : undefined);
  const primaryExhausted = primaryRemaining !== undefined
    ? primaryRemaining <= 0
    : summary.current.primary >= 100;
  const secondaryExhausted = secondaryRemaining !== undefined
    ? secondaryRemaining <= 0
    : summary.current.secondary >= 100;
  const primaryResetAt = summary.statusResetAt?.primary
    ?? summary.current.resetAtByScope?.primary
    ?? (primaryExhausted ? summary.current.resetAt : undefined);
  const secondaryResetAt = summary.statusResetAt?.secondary
    ?? summary.current.resetAtByScope?.secondary
    ?? (secondaryExhausted ? summary.current.resetAt : undefined);
  return {
    [codexQuotaScopes.primary]: quotaScopeRecord({
      status: primaryExhausted ? "exhausted" : "available",
      usedPercent: summary.current.primary,
      remainingPercent: primaryRemaining,
      resetAt: primaryResetAt,
      resetText: summary.statusResetText?.primary,
      reason: primaryExhausted ? "5h quota exhausted" : undefined,
      checkedAt,
    }),
    [codexQuotaScopes.secondary]: quotaScopeRecord({
      status: secondaryExhausted ? "exhausted" : "available",
      usedPercent: summary.current.secondary,
      remainingPercent: secondaryRemaining,
      resetAt: secondaryResetAt,
      resetText: summary.statusResetText?.secondary,
      reason: secondaryExhausted ? "weekly quota exhausted" : undefined,
      checkedAt,
    }),
  };
}

function updateSummary(summary, file, lineNumber, event) {
  const rateLimits = event.payload?.rate_limits;
  if (!rateLimits) return;
  const primary = rateLimits.primary?.used_percent ?? 0;
  const secondary = rateLimits.secondary?.used_percent ?? 0;
  const reachedType = rateLimits.rate_limit_reached_type ?? null;
  const timestamp = event.timestamp;

  summary.tokenCountRecords += 1;
  summary.maxPrimary = Math.max(summary.maxPrimary, primary);
  summary.maxSecondary = Math.max(summary.maxSecondary, secondary);
  if (!summary.firstAt || timestamp < summary.firstAt) summary.firstAt = timestamp;
  if (!summary.lastAt || timestamp > summary.lastAt) {
    summary.lastAt = timestamp;
    summary.current = {
      file,
      line: lineNumber,
      timestamp,
      primary,
      secondary,
      reachedType,
      resetAt: pickReset(rateLimits),
      resetAtByScope: {
        primary: epochSecondsToIso(rateLimits.primary?.resets_at),
        secondary: epochSecondsToIso(rateLimits.secondary?.resets_at),
      },
      credits: rateLimits.credits,
      planType: rateLimits.plan_type,
    };
  }
  if (rateLimits.credits) summary.lastCredits = rateLimits.credits;
  if (rateLimits.plan_type) summary.planType = rateLimits.plan_type;
  if (reachedType) summary.reachedTypes.add(String(reachedType));

  const exhausted = primary >= 100 || secondary >= 100 || reachedType !== null;
  if (primary >= 90 || secondary >= 90 || exhausted) {
    summary.highWatermarks.push({
      file,
      line: lineNumber,
      timestamp,
      primary,
      secondary,
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
      primary >= 100 ? "primary rate limit reached" : "secondary rate limit reached"
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
    ),
  );
  if (summary.exhausted) {
    summary.reason = summary.current.reachedType
      ? `rate_limit_reached_type=${summary.current.reachedType}`
      : (summary.current.primary >= 100 ? "primary rate limit reached" : "secondary rate limit reached");
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
