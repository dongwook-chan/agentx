import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { productConfigDir } from "./paths.js";

export function parseCodexQuotaLine(line) {
  if (!line.includes("\"token_count\"") && !line.includes("usage_limit_exceeded")) return undefined;
  let value;
  try { value = JSON.parse(line); }
  catch { return undefined; }
  if (value.type !== "event_msg") return undefined;
  if (
    value.payload?.type === "task_complete"
    && value.payload?.error?.codex_error_info === "usage_limit_exceeded"
  ) {
    const message = String(value.payload.error.message ?? "");
    const retryMatch = message.match(/try again at\s+(.+?)(?:\.(?:\s|$)|$)/i);
    const retryText = retryMatch?.[1]?.replace(/(\d+)(?:st|nd|rd|th)\b/gi, "$1");
    const retryMs = Date.parse(retryText ?? "");
    return {
      timestamp: value.timestamp,
      primary: 0,
      secondary: 0,
      reachedType: "usage_limit_exceeded",
      reason: "usage limit reached",
      resetAt: Number.isFinite(retryMs) ? new Date(retryMs).toISOString() : undefined,
    };
  }
  if (value.payload?.type !== "token_count" || !value.payload?.rate_limits) return undefined;
  const limits = value.payload.rate_limits;
  const primary = Number(limits?.primary?.used_percent ?? 0);
  const secondary = Number(limits?.secondary?.used_percent ?? 0);
  const reachedType = limits?.rate_limit_reached_type ?? null;
  // `has_credits=false` is also emitted for Plus accounts that simply have no
  // purchased overage balance. It is informational unless Codex reports an
  // actual reached type or usage-limit error.
  if (primary < 100 && secondary < 100 && reachedType === null) return undefined;
  const resetsAt = primary >= 100
    ? limits?.primary?.resets_at
    : (secondary >= 100 ? limits?.secondary?.resets_at : limits?.primary?.resets_at ?? limits?.secondary?.resets_at);
  return {
    timestamp: value.timestamp,
    primary,
    secondary,
    primaryWindowMinutes: Number.isFinite(Number(limits?.primary?.window_minutes))
      ? Number(limits.primary.window_minutes)
      : undefined,
    secondaryWindowMinutes: Number.isFinite(Number(limits?.secondary?.window_minutes))
      ? Number(limits.secondary.window_minutes)
      : undefined,
    reachedType,
    resetAt: Number.isFinite(Number(resetsAt)) ? new Date(Number(resetsAt) * 1000).toISOString() : undefined,
    planType: limits?.plan_type,
  };
}

export function parseCodexProtocolMessage(message) {
  if (!message || typeof message !== "object") return undefined;
  if (message.method === "account/rateLimits/updated") {
    const limits = message.params?.rateLimits;
    if (!limits) return undefined;
    const primary = Number(limits.primary?.usedPercent ?? 0);
    const secondary = Number(limits.secondary?.usedPercent ?? 0);
    const reachedType = limits.rateLimitReachedType ?? null;
    if (primary < 100 && secondary < 100 && reachedType === null) return undefined;
    const resetsAt = primary >= 100
      ? limits.primary?.resetsAt
      : limits.secondary?.resetsAt;
    return {
      timestamp: new Date().toISOString(),
      primary,
      secondary,
      primaryWindowMinutes: Number.isFinite(Number(limits.primary?.windowDurationMins ?? limits.primary?.windowMinutes))
        ? Number(limits.primary?.windowDurationMins ?? limits.primary?.windowMinutes)
        : undefined,
      secondaryWindowMinutes: Number.isFinite(Number(limits.secondary?.windowDurationMins ?? limits.secondary?.windowMinutes))
        ? Number(limits.secondary?.windowDurationMins ?? limits.secondary?.windowMinutes)
        : undefined,
      reachedType,
      reason: reachedType
        ? `rate_limit_reached_type=${reachedType}`
        : (primary >= 100 ? "primary rate limit reached" : "secondary rate limit reached"),
      resetAt: Number.isFinite(Number(resetsAt))
        ? new Date(Number(resetsAt) * 1000).toISOString()
        : undefined,
    };
  }

  const error = message.method === "error"
    ? message.params?.error
    : (message.method === "turn/completed" && message.params?.turn?.status === "failed"
      ? message.params.turn.error
      : undefined);
  if (!error) return undefined;
  const errorInfo = JSON.stringify(error.codexErrorInfo ?? error.codex_error_info ?? "");
  const messageText = String(error.message ?? "");
  if (!/usage.?limit.?exceeded/i.test(errorInfo) && !/usage limit/i.test(messageText)) return undefined;
  return {
    timestamp: new Date().toISOString(),
    primary: 0,
    secondary: 0,
    reachedType: "usage_limit_exceeded",
    reason: messageText || "usage limit reached",
  };
}

export function detectAgyConversation(text) {
  const pattern = /(?:Created conversation|GetConversationDetail: found conversation|Conversation using ID:) ([0-9a-f-]{36})/gi;
  let latest;
  for (const match of text.matchAll(pattern)) latest = match[1];
  return latest;
}

export function parseAgyModelLine(line) {
  let match = line.match(/Propagating selected model override to backend:\s+label="([^"]+)"/i);
  if (!match) match = line.match(/Resolving model\s+(.+)$/i);
  if (!match) return undefined;
  const label = match[1].trim();
  const lower = label.toLowerCase();
  let scope = "unknown";
  if (lower.includes("gemini")) scope = lower.includes("flash") ? "gemini-flash" : (lower.includes("pro") ? "gemini-pro" : "gemini");
  else if (lower.includes("claude") || lower.includes("gpt-oss") || lower.includes("gpt oss")) scope = "claude-gpt";
  return { label, scope };
}

export function parseAgyQuotaLine(line) {
  const lower = line.toLowerCase();
  const looksLikeQuota = lower.includes("resource_exhausted")
    || lower.includes("individual quota reached")
    || /\bcode\s*[:=]?\s*429\b/i.test(line)
    || (/\b429\b/.test(line) && /(quota|rate|limit|exhausted)/i.test(line))
    || /(quota|rate limit).*(exceeded|exhausted|reached)/i.test(line);
  if (!looksLikeQuota) return undefined;
  const reason = lower.includes("individual quota reached")
    ? "individual quota reached"
    : (lower.includes("resource_exhausted") ? "RESOURCE_EXHAUSTED" : (/\b429\b/.test(line) ? "HTTP 429" : "quota exhausted"));
  return { reason };
}

export async function activeProfile(product) {
  const path = join(productConfigDir(product), "state.json");
  const state = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
  return state.activeProfile;
}

export async function recordAgyQuota(profileName, event) {
  const path = join(productConfigDir("agyx"), "state.json");
  const state = JSON.parse(await readFile(path, "utf8").catch(() => "{\"version\":1,\"profiles\":[]}"));
  const profile = state.profiles?.find((entry) => entry.name === profileName || entry.previousNames?.includes(profileName));
  if (!profile) return;
  const now = new Date().toISOString();
  const scope = event.scope ?? "unknown";
  profile.lastQuotaErrorAt = now;
  profile.lastQuotaReason = event.reason;
  profile.quotaScopes = profile.quotaScopes ?? {};
  profile.quotaScopes[scope] = {
    status: "exhausted",
    reason: event.reason,
    errorAt: now,
    ...(event.modelLabel ? { modelLabel: event.modelLabel } : {}),
  };
  if (scope === "unknown") profile.quotaStatus = "exhausted";
  profile.updatedAt = now;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
