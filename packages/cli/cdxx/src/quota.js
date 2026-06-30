import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexHome, clearExpiredQuota, loadState, saveState } from "./config.js";

export const sessionsDir = join(codexHome, "sessions");

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

export async function recordQuotaForProfile(summary, profileName) {
  const state = await loadState();
  const profile = state.profiles.find((entry) => entry.name === profileName);
  if (!profile) return undefined;
  clearExpiredQuota(profile);
  const now = new Date().toISOString();
  profile.lastScanAt = now;
  profile.lastUsage = {
    maxPrimary: summary.maxPrimary,
    maxSecondary: summary.maxSecondary,
    planType: summary.planType,
    lastAt: summary.lastAt,
    credits: summary.lastCredits,
  };
  if (summary.exhausted) {
    profile.quotaStatus = "exhausted";
    profile.quotaResetAt = summary.resetAt;
    profile.lastQuotaReason = summary.reason;
    profile.lastQuotaErrorAt = summary.lastAt ?? now;
  } else if (summary.tokenCountRecords > 0) {
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
