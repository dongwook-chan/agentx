import {
  AutoSwitchMode,
  defaultAllowIneligibleActivation,
  effectiveAllowIneligibleActivation,
  LegacyAutoSwitchMode,
  normalizeAutoSwitchMode,
  ProfileRecord,
  State,
} from "./config.js";
import { QuotaScope, quotaScopeAliases } from "./quota.js";
import {
  agentCliManifests,
  selectAutoSwitchCandidate,
  selectRoundRobinProfile,
  shouldAutoSwitchForQuota,
} from "@dong-/agentx-core";

export type ProfileRuntimeStatus =
  | "ready"
  | "exhausted"
  | "disabled"
  | "mismatch"
  | "error"
  | "ineligible";

export interface EffectiveStatusOptions {
  quotaScope?: QuotaScope;
  quotaScopes?: QuotaScope[];
  allowIneligibleActivation?: boolean;
}

function effectiveScopes(options: EffectiveStatusOptions): QuotaScope[] {
  return [
    ...(options.quotaScopes ?? []),
    ...(options.quotaScope ? [options.quotaScope] : []),
  ].filter((scope, index, scopes) =>
    scope !== "unknown" && scopes.indexOf(scope) === index
  );
}

const providerQuotaScopes: QuotaScope[] = ["gemini-flash", "gemini-pro", "claude-gpt"];

function quotaActive(resetAt: string | undefined, now: Date): boolean {
  return !resetAt || Date.parse(resetAt) > now.getTime();
}

function hasProfileWideQuota(profile: ProfileRecord, now: Date): boolean {
  if (
    profile.quotaStatus === "exhausted"
    && quotaActive(profile.quotaResetAt, now)
  ) {
    return true;
  }
  const unknown = profile.quotaScopes?.unknown;
  return Boolean(unknown && quotaActive(unknown.resetAt, now));
}

export function isScopeQuotaExhausted(
  profile: ProfileRecord,
  scope: QuotaScope,
  now = new Date(),
): boolean {
  if (scope === "unknown") return hasProfileWideQuota(profile, now);
  if (hasProfileWideQuota(profile, now)) return true;
  return quotaScopeAliases(scope).some((candidate) => {
    const quota = profile.quotaScopes?.[candidate];
    return Boolean(quota?.status === "exhausted" && quotaActive(quota.resetAt, now));
  });
}

function allowIneligibleActivation(options: EffectiveStatusOptions): boolean {
  return options.allowIneligibleActivation ?? defaultAllowIneligibleActivation;
}

function isBaseSelectable(
  profile: ProfileRecord,
  options: EffectiveStatusOptions = {},
): boolean {
  return !profile.disabled
    && profile.credentialStatus !== "mismatch"
    && profile.credentialStatus !== "error"
    && (
      profile.eligibilityStatus !== "ineligible"
      || allowIneligibleActivation(options)
    );
}

export function scopedQuotaResetAt(
  profile: ProfileRecord,
  scope: QuotaScope | undefined,
  now = new Date(),
): string | undefined {
  if (!scope || scope === "unknown") return undefined;
  const resets = quotaScopeAliases(scope)
    .map((candidate) => profile.quotaScopes?.[candidate]?.resetAt)
    .filter((resetAt): resetAt is string =>
      typeof resetAt === "string" && Date.parse(resetAt) > now.getTime()
    )
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return resets[0];
}

export function exhaustedQuotaScope(
  profile: ProfileRecord,
  scope: QuotaScope | undefined,
  now = new Date(),
): QuotaScope | undefined {
  if (hasProfileWideQuota(profile, now)) return "unknown";
  if (!scope || scope === "unknown") return undefined;
  return isScopeQuotaExhausted(profile, scope, now) ? scope : undefined;
}

export function exhaustedQuotaScopeForOptions(
  profile: ProfileRecord,
  options: EffectiveStatusOptions,
  now = new Date(),
): QuotaScope | undefined {
  const profileWide = exhaustedQuotaScope(profile, undefined, now);
  if (profileWide) return profileWide;
  for (const scope of effectiveScopes(options)) {
    const exhaustedScope = exhaustedQuotaScope(profile, scope, now);
    if (exhaustedScope) return exhaustedScope;
  }
  return undefined;
}

export function effectiveProfileStatus(
  profile: ProfileRecord,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): ProfileRuntimeStatus {
  if (profile.disabled) return "disabled";
  if (profile.credentialStatus === "mismatch") return "mismatch";
  if (profile.credentialStatus === "error") return "error";
  if (profile.eligibilityStatus === "ineligible") return "ineligible";
  return exhaustedQuotaScopeForOptions(profile, options, now) ? "exhausted" : "ready";
}

export function shouldAutoSwitchAfterQuota(
  profile: ProfileRecord | undefined,
  mode: AutoSwitchMode | LegacyAutoSwitchMode | undefined,
  quotaScope: QuotaScope,
  now = new Date(),
): boolean {
  return shouldAutoSwitchForQuota(profile, {
    mode: normalizeAutoSwitchMode(mode),
    triggerScope: quotaScope,
    switchableScopes: providerQuotaScopes,
    candidateQuotaPolicy: agentCliManifests.agy.quotaFailover.candidateQuotaPolicy,
    unknownScope: "unknown",
    scopeAliases: quotaScopeAliases,
    now,
  });
}

export function selectAutoSwitchProfile(
  state: State,
  mode: Exclude<AutoSwitchMode, "off"> | LegacyAutoSwitchMode,
  quotaScope: QuotaScope,
  now = new Date(),
): ProfileRecord {
  if (!state.profiles.length) throw new Error("No saved profiles.");
  const selected = selectAutoSwitchCandidate(state, {
    mode: normalizeAutoSwitchMode(mode),
    triggerScope: quotaScope,
    switchableScopes: providerQuotaScopes,
    candidateQuotaPolicy: agentCliManifests.agy.quotaFailover.candidateQuotaPolicy,
    unknownScope: "unknown",
    scopeAliases: quotaScopeAliases,
    allowIneligibleActivation: effectiveAllowIneligibleActivation(state),
    now,
  });
  if (!selected) throw new Error("No selectable profile for automatic quota failover.");
  return selected;
}

export function isProfileSelectable(
  profile: ProfileRecord,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): boolean {
  return isBaseSelectable(profile, options)
    && !exhaustedQuotaScopeForOptions(profile, options, now);
}

export function selectNextProfile(
  state: State,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): ProfileRecord {
  if (!state.profiles.length) throw new Error("No saved profiles.");
  const effectiveOptions: EffectiveStatusOptions = {
    ...options,
    allowIneligibleActivation: options.allowIneligibleActivation
      ?? effectiveAllowIneligibleActivation(state),
  };
  const selected = selectRoundRobinProfile(
    state,
    (profile) => isProfileSelectable(profile, now, effectiveOptions),
  );
  if (selected) return selected;

  const resetEntries = state.profiles.flatMap((profile) => {
    const resets: Array<{ name: string; resetAt: string }> = [];
    if (profile.quotaResetAt) resets.push({ name: profile.name, resetAt: profile.quotaResetAt });
    for (const scope of effectiveScopes(effectiveOptions)) {
      const resetAt = profile.quotaScopes?.[scope]?.resetAt;
      if (resetAt) resets.push({ name: `${profile.name}:${scope}`, resetAt });
    }
    return resets;
  });
  const earliestReset = resetEntries
    .sort((left, right) => Date.parse(left.resetAt) - Date.parse(right.resetAt))[0];
  const credentialIssues = state.profiles
    .filter((profile) =>
      profile.credentialStatus === "mismatch"
      || profile.credentialStatus === "error"
      || (
        profile.eligibilityStatus === "ineligible"
        && !allowIneligibleActivation(effectiveOptions)
      )
    )
    .map((profile) =>
      profile.eligibilityStatus === "ineligible"
        ? `${profile.name}:ineligible`
        : `${profile.name}:${profile.credentialStatus}`
    )
    .join(", ");
  const resetText = earliestReset
    ? ` Earliest reset: ${earliestReset.name} at ${earliestReset.resetAt}.`
    : "";
  const credentialText = credentialIssues
    ? ` Credential issues: ${credentialIssues}.`
    : "";
  throw new Error(`No selectable profiles.${credentialText}${resetText}`);
}
