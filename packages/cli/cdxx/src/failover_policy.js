import { appendAgentEvent, decideLiveQuotaFailover, decideObservedProfileFailover, quotaSwitchingNotice, selectVerifiedAutoSwitchCandidate, stopRetryingAutoSwitch } from "@dong-/agentx-core";
import { effectiveAutoSwitchMode, eventLogPath, loadState } from "./config.js";
import { recordQuotaForProfile } from "./quota.js";
import { useProfile } from "./auth.js";
import { withPausedAuthSwitch } from "./managed_sessions.js";
import { startBackgroundProfileStatusRefresh, verifyProfileStatuses } from "./background_status.js";
import { withAuthSwitchLock } from "./lock.js";

async function logFailoverEvent(event) {
  await appendAgentEvent(eventLogPath, { product: "cdxx", ...event }).catch(() => undefined);
}

export function quotaSummaryFromSupervisorPayload(payload) {
  const now = new Date().toISOString();
  const primary = payload.primary === undefined || payload.primary === null
    ? undefined
    : Number(payload.primary);
  const secondary = payload.secondary === undefined || payload.secondary === null
    ? undefined
    : Number(payload.secondary);
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
    reason: payload.reason ?? (reachedType
      ? `rate_limit_reached_type=${reachedType}`
      : (primary >= 100
        ? "primary rate limit reached"
        : (secondary >= 100 ? "secondary rate limit reached" : "quota exhausted"))),
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
      windowMinutes: {
        primary: payload.primaryWindowMinutes,
        secondary: payload.secondaryWindowMinutes,
        monthly: undefined,
      },
    },
    highWatermarks: [],
  };
}

function quotaSummaryForFailover(payload) {
  return payload.summary ?? quotaSummaryFromSupervisorPayload(payload);
}

export async function decideCodexFailover(payload, options = {}) {
  const summary = quotaSummaryForFailover(payload);
  const policy = decideLiveQuotaFailover(Boolean(summary.exhausted));
  return await withAuthSwitchLock(async () => {
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
      return stopRetryingAutoSwitch(
        "profile_not_found",
        `[cdxx] Active profile '${payload.profileName ?? "(none)"}' was not found; quota failover stopped.`,
      );
    }

    if (!policy.switchImmediately) {
      await logFailoverEvent({
        event: "switch.stopped",
        trigger: "autoswitch",
        reason: "quota_available_by_status",
        fromProfile: profile.name,
        sessionId: payload.sessionId,
      });
      return stopRetryingAutoSwitch(
        "quota_available_by_status",
        `[cdxx] /status no longer reports quota exhaustion for '${profile.name}'; failover stopped.`,
        { profile: profile.name },
      );
    }

    const shouldRefreshStatusAfterSwitch = !summary.resetAt && !policy.usageRefreshMayBlock;

    const state = await loadState();
    const ownership = decideObservedProfileFailover(profile.name, state.activeProfile);
    if (!ownership.switchProfile) {
      await logFailoverEvent({
        event: "switch.stopped",
        trigger: "autoswitch",
        reason: ownership.reason,
        fromProfile: profile.name,
        activeProfile: state.activeProfile,
        sessionId: payload.sessionId,
      });
      return {
        ok: true,
        kind: "none",
        reason: ownership.reason,
        profile: state.activeProfile,
        sessionId: payload.sessionId,
        message: `[cdxx] Quota was reported for '${profile.name}', but '${state.activeProfile ?? "(none)"}' is already active; no additional profile switch was made.`,
      };
    }

    const autoSwitchMode = effectiveAutoSwitchMode(state);
    if (autoSwitchMode === "off") {
      await logFailoverEvent({
        event: "switch.stopped",
        trigger: "autoswitch",
        reason: "autoswitch_off",
        fromProfile: profile.name,
        sessionId: payload.sessionId,
      });
      return stopRetryingAutoSwitch(
        "autoswitch_off",
        "[cdxx] Autoswitch is off; quota failover stopped.",
        { profile: profile.name },
      );
    }

    const verifyCandidates = options.verifyCandidates ?? verifyProfileStatuses;
    const candidateNames = state.profiles
      .filter((candidate) => candidate.name !== profile.name)
      .map((candidate) => candidate.name);
    const verifications = await verifyCandidates(candidateNames);
    for (const verification of verifications) {
      await logFailoverEvent({
        event: "candidate.verified",
        trigger: "autoswitch",
        fromProfile: profile.name,
        candidateProfile: verification.profileName,
        status: verification.status,
        reason: verification.reason,
        recordError: verification.recordError,
        sessionId: payload.sessionId,
      });
    }
    const verifiedState = await loadState();
    const selection = selectVerifiedAutoSwitchCandidate(verifiedState, verifications);
    const next = selection.profile;
    if (!next && selection.reason === "candidate_verification_failed") {
      await logFailoverEvent({
        event: "switch.stopped",
        trigger: "autoswitch",
        reason: "candidate_verification_failed",
        fromProfile: profile.name,
        failedProfiles: selection.failedProfiles,
        sessionId: payload.sessionId,
      });
      return stopRetryingAutoSwitch(
        "candidate_verification_failed",
        `[cdxx] Could not verify a usable failover profile: ${selection.failedProfiles.join(", ")}.`,
        { profile: profile.name, failedProfiles: selection.failedProfiles },
      );
    }
    if (!next) {
      await logFailoverEvent({
        event: "switch.stopped",
        trigger: "autoswitch",
        reason: "no_selectable_profile",
        fromProfile: profile.name,
        sessionId: payload.sessionId,
      });
      return stopRetryingAutoSwitch(
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
    const switched = await withPausedAuthSwitch(
      async () => await useProfile(next.name, { force: true }),
      { switchingNotice: quotaSwitchingNotice("cdxx") },
    );
    if (shouldRefreshStatusAfterSwitch) {
      const scheduleStatusRefresh = options.scheduleStatusRefresh ?? startBackgroundProfileStatusRefresh;
      try {
        // Probe the exhausted profile only after its sessions have stopped and
        // the new profile is active, avoiding concurrent refreshes in one token
        // family while still keeping status off the failover foreground path.
        const scheduled = scheduleStatusRefresh(profile.name);
        if (scheduled && typeof scheduled.catch === "function") void scheduled.catch(() => undefined);
      } catch {
        // Status metadata is best-effort; failover policy must still proceed.
      }
    }
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
  });
}
