export interface QuotaEvent {
  reason: string;
  resetAt?: string;
  scope?: QuotaScope;
  modelLabel?: string;
}

export type QuotaScope =
  | "gemini-flash"
  | "gemini-pro"
  | "claude-gpt"
  | "claude"
  | "gemini"
  | "gpt-oss"
  | "unknown";

export function quotaScopeAliases(scope: QuotaScope): QuotaScope[] {
  switch (scope) {
    case "gemini-flash":
    case "gemini-pro":
      return [scope, "gemini"];
    case "claude-gpt":
      return [scope, "claude", "gpt-oss"];
    case "claude":
    case "gpt-oss":
      return ["claude-gpt", scope];
    case "gemini":
      return ["gemini-flash", "gemini-pro", "gemini"];
    default:
      return [scope];
  }
}

export interface ModelEvent {
  label: string;
  scope: QuotaScope;
}

export interface UsageTranscriptEvent {
  status: "available" | "exhausted";
  scope: QuotaScope;
  modelLabel?: string;
  reason?: string;
  resetAt?: string;
  remainingPercent?: number;
}

export interface UsageScopeAggregate {
  status: "available" | "exhausted";
  scope: QuotaScope;
  resetAt?: string;
  reason?: string;
  modelLabel?: string;
  remainingPercent?: number;
}

export interface UsageTranscriptState {
  inUsageView: boolean;
  modelLabel?: string;
  scope?: QuotaScope;
  remainingPercent?: number;
}

export function createUsageTranscriptState(): UsageTranscriptState {
  return { inUsageView: false };
}

export function isRequestEventLine(line: string): boolean {
  return /Sending user message to conversation [0-9a-f-]{36}/i.test(line);
}

export function classifyModelScope(label: string | undefined): QuotaScope {
  if (!label) return "unknown";
  const lower = label.toLowerCase();
  if (lower.includes("claude")) return "claude-gpt";
  if (lower.includes("gpt-oss") || lower.includes("gpt oss")) return "claude-gpt";
  if (lower.includes("gemini")) {
    if (lower.includes("flash")) return "gemini-flash";
    if (lower.includes("pro")) return "gemini-pro";
    return "gemini";
  }
  return "unknown";
}

export function parseModelEventLine(line: string): ModelEvent | undefined {
  const propagated = line.match(
    /Propagating selected model override to backend:\s+label="([^"]+)"/i,
  )?.[1];
  if (propagated) return { label: propagated, scope: classifyModelScope(propagated) };

  const resolving = line.match(/Resolving model\s+(.+)$/i)?.[1]?.trim();
  if (resolving) return { label: resolving, scope: classifyModelScope(resolving) };

  return undefined;
}

function parseDurationMs(value: string): number | undefined {
  const pattern =
    /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/gi;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(pattern)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (unit.startsWith("d")) total += amount * 24 * 60 * 60 * 1000;
    else if (unit.startsWith("h")) total += amount * 60 * 60 * 1000;
    else if (unit.startsWith("m")) total += amount * 60 * 1000;
    else total += amount * 1000;
  }
  return matched ? Math.round(total) : undefined;
}

function parseResetAt(line: string, now: Date): string | undefined {
  const resetIn = line.match(
    /(?:resets?|refresh(?:es)?|will\s+reset|will\s+refresh)\s+(?:in|after)\s+([0-9a-zA-Z.\s]+)/i,
  )?.[1];
  const resetMs = resetIn ? parseDurationMs(resetIn) : undefined;
  if (resetMs !== undefined) return new Date(now.getTime() + resetMs).toISOString();

  const retryAfter = line.match(/retry-after["'\s:=]+(\d+)/i)?.[1];
  if (retryAfter) {
    return new Date(now.getTime() + Number(retryAfter) * 1000).toISOString();
  }

  return undefined;
}

export function normalizeTerminalTranscript(input: string): string {
  let output = input
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[=>()#][0-9A-Za-z]?/g, "")
    .replace(/\r/g, "\n");

  let normalized = "";
  for (const char of output) {
    if (char === "\b") {
      normalized = normalized.slice(0, -1);
      continue;
    }
    const code = char.charCodeAt(0);
    if (char === "\n" || char === "\t" || code >= 32) normalized += char;
  }
  return normalized;
}

function parseRemainingPercent(line: string): number | undefined {
  const percent = line.match(/(\d+(?:\.\d+)?)\s*%/)?.[1];
  if (!percent) return undefined;
  const value = Number(percent);
  return Number.isFinite(value) ? value : undefined;
}

function parseUsageStatus(line: string): "available" | "exhausted" | undefined {
  const lower = line.toLowerCase();
  if (
    lower.includes("exhausted")
    || lower.includes("locked out")
    || lower.includes("lockout")
    || lower.includes("capacity reached")
    || lower.includes("quota reached")
    || lower.includes("limit reached")
    || lower.includes("no quota")
    || lower.includes("no remaining")
  ) {
    return "exhausted";
  }
  if (lower.includes("quota available") || lower === "available") return "available";

  const percent = parseRemainingPercent(line);
  if (percent !== undefined) return percent <= 0.5 ? "exhausted" : "available";

  return undefined;
}

function usageModelLabel(line: string): string | undefined {
  const cleaned = line
    .replace(/[|#=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

export function parseUsageTranscriptLine(
  line: string,
  state: UsageTranscriptState,
  now = new Date(),
): UsageTranscriptEvent | undefined {
  const cleaned = normalizeTerminalTranscript(line).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;

  if (/Models\s+&\s+Quota/i.test(cleaned)) {
    state.inUsageView = true;
    state.modelLabel = undefined;
    state.scope = undefined;
    state.remainingPercent = undefined;
    return undefined;
  }
  if (!state.inUsageView) return undefined;
  if (/^(?:esc\s+Close|Scroll|CLI program exited)/i.test(cleaned)) {
    state.inUsageView = false;
    state.modelLabel = undefined;
    state.scope = undefined;
    state.remainingPercent = undefined;
    return undefined;
  }

  const lineScope = classifyModelScope(cleaned);
  if (lineScope !== "unknown") {
    state.modelLabel = usageModelLabel(cleaned);
    state.scope = lineScope;
    state.remainingPercent = undefined;
    return undefined;
  }

  if (!state.scope) return undefined;

  const quotaEvent = parseQuotaEventLine(cleaned, now);
  const parsedResetAt = parseResetAt(cleaned, now);
  let status = quotaEvent ? "exhausted" : parseUsageStatus(cleaned);
  if (!status && parsedResetAt && state.remainingPercent !== undefined) {
    status = state.remainingPercent <= 0.5 ? "exhausted" : "available";
  }
  if (!status) return undefined;
  const lineRemainingPercent = parseRemainingPercent(cleaned);
  if (lineRemainingPercent !== undefined) state.remainingPercent = lineRemainingPercent;
  const remainingPercent = lineRemainingPercent ?? state.remainingPercent;

  return {
    status,
    scope: state.scope,
    modelLabel: state.modelLabel,
    reason: quotaEvent?.reason ?? (status === "exhausted" ? "usage quota exhausted" : undefined),
    resetAt: quotaEvent?.resetAt ?? parsedResetAt,
    remainingPercent,
  };
}

function isEarlierReset(next: string | undefined, current: string | undefined): boolean {
  if (!next) return !current;
  if (!current) return true;
  const nextTime = Date.parse(next);
  const currentTime = Date.parse(current);
  if (!Number.isFinite(nextTime)) return false;
  if (!Number.isFinite(currentTime)) return true;
  return nextTime < currentTime;
}

export function parseUsageTranscriptAggregates(
  transcript: string,
  now = new Date(),
  state = createUsageTranscriptState(),
): UsageScopeAggregate[] {
  const aggregates = new Map<QuotaScope, UsageScopeAggregate>();
  for (const line of normalizeTerminalTranscript(transcript).split(/\n/)) {
    const event = parseUsageTranscriptLine(line, state, now);
    if (!event) continue;

    const current = aggregates.get(event.scope);
    if (event.status === "available") {
      if (
        !current
        || (
          current.status === "available"
          && (
            (
              event.remainingPercent !== undefined
              && (
                current.remainingPercent === undefined
                || event.remainingPercent < current.remainingPercent
              )
            )
            || (
              event.resetAt
              && !current.resetAt
            )
          )
        )
      ) {
        const resetAt = event.resetAt ?? current?.resetAt;
        aggregates.set(event.scope, {
          status: "available",
          scope: event.scope,
          modelLabel: event.modelLabel,
          ...(resetAt ? { resetAt } : {}),
          remainingPercent: event.remainingPercent,
        });
      }
      continue;
    }

    const next: UsageScopeAggregate = {
      status: "exhausted",
      scope: event.scope,
      resetAt: event.resetAt,
      reason: event.reason ?? "usage quota exhausted",
      modelLabel: event.modelLabel,
      remainingPercent: event.remainingPercent,
    };
    if (
      !current
      || current.status === "available"
      || isEarlierReset(next.resetAt, current.resetAt)
    ) {
      aggregates.set(event.scope, next);
    }
  }
  return [...aggregates.values()];
}

export function parseQuotaEventLine(
  line: string,
  now = new Date(),
): QuotaEvent | undefined {
  const lower = line.toLowerCase();
  const looksLikeQuota =
    lower.includes("resource_exhausted")
    || lower.includes("individual quota reached")
    || /\bcode\s*[:=]?\s*429\b/i.test(line)
    || /\b429\b/.test(line) && /(quota|rate|limit|exhausted)/i.test(line)
    || /(quota|rate limit).*(exceeded|exhausted|reached)/i.test(line);
  if (!looksLikeQuota) return undefined;

  let reason = "quota exhausted";
  if (lower.includes("individual quota reached")) reason = "individual quota reached";
  else if (lower.includes("resource_exhausted")) reason = "RESOURCE_EXHAUSTED";
  else if (/\b429\b/.test(line)) reason = "HTTP 429";

  return {
    reason,
    resetAt: parseResetAt(line, now),
  };
}
