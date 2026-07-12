import { appendAgentEvent } from "@dong-/agentx-core";
import { loadState } from "./config.js";
import { eventLogPath } from "./config.js";
import { recordQuotaForProfile, scanCodexQuota } from "./quota.js";
import { useProfile } from "./auth.js";
import { pickNextProfile } from "./selection.js";
import { withPausedAuthSwitch } from "./managed_sessions.js";

async function logFailoverEvent(event) {
  await appendAgentEvent(eventLogPath, { product: "cdxx", ...event }).catch(() => undefined);
}

export function quotaSummaryFromSupervisorPayload(payload) {
  const now = new Date().toISOString();
  const primary = Number(payload.primary ?? 0);
  const secondary = Number(payload.secondary ?? 0);
  const reachedType = payload.reachedType ?? null;
  return {
    scannedFiles: 1,
    tokenCountRecords: 1,
    maxPrimary: primary,
    maxSecondary: secondary,
    firstAt: payload.timestamp ?? now,
    lastAt: payload.timestamp ?? now,
    planType: payload.planType,
    lastCredits: undefined,
    exhausted: true,
    historicalExhausted: true,
    exhaustedEvents: 1,
    reason: reachedType
      ? `rate_limit_reached_type=${reachedType}`
      : (primary >= 100 ? "primary rate limit reached" : "secondary rate limit reached"),
    resetAt: payload.resetAt,
    reachedTypes: reachedType ? [String(reachedType)] : [],
    current: {
      file: undefined,
      line: undefined,
      timestamp: payload.timestamp ?? now,
      primary,
      secondary,
      reachedType,
      resetAt: payload.resetAt,
      credits: undefined,
      planType: payload.planType,
    },
    highWatermarks: [],
  };
}

export function stopRetryingAction(reason, message, extra = {}) {
  return {
    ok: false,
    kind: "stop_retrying",
    reason,
    message,
    retryKey: extra.retryKey,
    ...extra,
  };
}

async function quotaSummaryForFailover(payload) {
  if (payload.summary) return payload.summary;
  const fallback = quotaSummaryFromSupervisorPayload(payload);
  if (fallback.resetAt) return fallback;
  try {
    const statusSummary = await scanCodexQuota({
      reason: "live-quota-trigger",
      allowLocalFallback: false,
    });
    if (statusSummary?.source === "status") return statusSummary;
  } catch {
    // The supervisor payload is still a reliable live trigger if /status probing fails.
  }
  return fallback;
}

export async function decideCodexFailover(payload) {
  const summary = await quotaSummaryForFailover(payload);
  const profile = await recordQuotaForProfile(summary, payload.profileName);
  await logFailoverEvent({
    event: "quota.detected",
    trigger: "supervisor",
    profile: payload.profileName,
    sessionId: payload.sessionId,
    exhausted: summary.exhausted,
    reason: summary.reason,
    resetAt: summary.resetAt,
    source: summary.source ?? "supervisor-payload",
    reachedType: payload.reachedType,
  });
  if (!profile) {
    await logFailoverEvent({
      event: "switch.stopped",
      trigger: "autoswitch",
      reason: "profile_not_found",
      fromProfile: payload.profileName,
      sessionId: payload.sessionId,
    });
    return stopRetryingAction(
      "profile_not_found",
      `[cdxx] Active profile '${payload.profileName ?? "(none)"}' was not found; quota failover stopped.`,
    );
  }

  if (!summary.exhausted) {
    await logFailoverEvent({
      event: "switch.stopped",
      trigger: "autoswitch",
      reason: "quota_available_by_status",
      fromProfile: profile.name,
      sessionId: payload.sessionId,
    });
    return stopRetryingAction(
      "quota_available_by_status",
      `[cdxx] /status no longer reports quota exhaustion for '${profile.name}'; failover stopped.`,
      { profile: profile.name },
    );
  }

  const state = await loadState();
  if (!state.settings?.autoswitch) {
    await logFailoverEvent({
      event: "switch.stopped",
      trigger: "autoswitch",
      reason: "autoswitch_off",
      fromProfile: profile.name,
      sessionId: payload.sessionId,
    });
    return stopRetryingAction(
      "autoswitch_off",
      "[cdxx] Autoswitch is off; quota failover stopped.",
      { profile: profile.name },
    );
  }

  const next = pickNextProfile(state, profile.name);
  if (!next) {
    await logFailoverEvent({
      event: "switch.stopped",
      trigger: "autoswitch",
      reason: "no_selectable_profile",
      fromProfile: profile.name,
      sessionId: payload.sessionId,
    });
    return stopRetryingAction(
      "no_selectable_profile",
      "[cdxx] No selectable profiles remain; quota failover stopped. Add another profile or wait for quota reset.",
      { profile: profile.name },
    );
  }

  await logFailoverEvent({
    event: "profile.selected",
    trigger: "autoswitch",
    fromProfile: profile.name,
    toProfile: next.name,
    sessionId: payload.sessionId,
    reason: summary.reason,
    resetAt: summary.resetAt,
  });
  const switched = await withPausedAuthSwitch(async () => await useProfile(next.name));
  await logFailoverEvent({
    event: "switch.completed",
    trigger: "autoswitch",
    fromProfile: profile.name,
    toProfile: switched.name ?? next.name,
    sessionId: payload.sessionId,
    reason: summary.reason,
    resetAt: summary.resetAt,
    actionKind: "sessions_restarted",
  });
  return {
    ok: true,
    kind: "sessions_restarted",
    profile: switched.name ?? next.name,
    sessionId: payload.sessionId,
    message: `[cdxx] Switched to '${switched.name ?? next.name}' after quota was reached; supervised Codex sessions are restarting with the active profile.`,
  };
}
