import { loadState } from "./config.js";
import { recordQuotaForProfile } from "./quota.js";
import { useProfile } from "./auth.js";
import { pickNextProfile } from "./selection.js";

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

export async function decideCodexFailover(payload) {
  const summary = payload.summary ?? quotaSummaryFromSupervisorPayload(payload);
  const profile = await recordQuotaForProfile(summary, payload.profileName);
  if (!profile) {
    return stopRetryingAction(
      "profile_not_found",
      `[cdxx] Active profile '${payload.profileName ?? "(none)"}' was not found; quota failover stopped.`,
    );
  }

  const state = await loadState();
  if (!state.settings?.autoswitch) {
    return stopRetryingAction(
      "autoswitch_off",
      "[cdxx] Autoswitch is off; quota failover stopped.",
      { profile: profile.name },
    );
  }

  const next = pickNextProfile(state, profile.name);
  if (!next) {
    return stopRetryingAction(
      "no_selectable_profile",
      "[cdxx] No selectable profiles remain; quota failover stopped. Add another profile or wait for quota reset.",
      { profile: profile.name },
    );
  }

  await useProfile(next.name);
  return {
    ok: true,
    kind: "switch_and_resume",
    profile: next.name,
    sessionId: payload.sessionId,
    message: `[cdxx] Switching to '${next.name}' and resuming ${payload.sessionId}.`,
  };
}
