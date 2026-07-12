import {
  effectiveAllowIneligibleActivation,
  ProfileRecord,
  State,
} from "./config.js";
import { relativeTime } from "@dong-/agentx-core";
import {
  effectiveProfileStatus,
  EffectiveStatusOptions,
  exhaustedQuotaScopeForOptions,
  isProfileSelectable,
  ProfileRuntimeStatus,
  scopedQuotaResetAt,
} from "./selection.js";
import { canonicalQuotaScope, QuotaScope } from "./quota.js";

export interface ProfileView {
  marker: string;
  number: string;
  name: string;
  expectedEmail: string;
  actualEmail: string;
  status: string;
  quotaReset: string;
  lastRequest: string;
  activated: string;
  verified: string;
  switches: string;
  selectable: boolean;
  runtimeStatus: ProfileRuntimeStatus;
  disabledReason?: string;
  profile: ProfileRecord;
}

export function profileStatusText(
  profile: ProfileRecord,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): string {
  const status = effectiveProfileStatus(profile, now, options);
  if (status === "disabled") return "disabled";
  if (status === "mismatch") return "mismatch";
  if (status === "error") return "auth-error";
  if (status === "ineligible") return "ineligible";
  if (status === "exhausted") {
    const exhaustedScope = exhaustedQuotaScopeForOptions(profile, options, now);
    return exhaustedScope && exhaustedScope !== "unknown"
      ? `quota:${canonicalQuotaScope(exhaustedScope)}`
      : "quota";
  }
  const scopedQuotaText = (Object.entries(profile.quotaScopes ?? {}) as Array<
    [QuotaScope, NonNullable<ProfileRecord["quotaScopes"]>[QuotaScope]]
  >)
    .filter(([scope, quota]) => {
      if (scope === "unknown" || !quota) return false;
      if (quota.resetAt && Date.parse(quota.resetAt) <= now.getTime()) return false;
      if (quota.status === "exhausted" && !quota.resetAt) return false;
      if (quota.status === "available" && !quota.resetAt) return false;
      return true;
    })
    .map(([scope, quota]) => canonicalQuotaScope(scope, quota?.modelLabel))
    .filter((scope, index, scopes) => scopes.indexOf(scope) === index)
    .join(",");
  if (scopedQuotaText) return `ready/${scopedQuotaText}`;
  return profile.quotaStatus === "available" ? "ready" : "unknown";
}

export function buildProfileViews(
  state: Pick<State, "activeProfile" | "profiles" | "settings">,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): ProfileView[] {
  const effectiveOptions: EffectiveStatusOptions = {
    ...options,
    allowIneligibleActivation: options.allowIneligibleActivation
      ?? effectiveAllowIneligibleActivation(state),
  };
  return state.profiles.map((profile, index) => {
    const runtimeStatus = effectiveProfileStatus(profile, now, effectiveOptions);
    const selectable = isProfileSelectable(profile, now, effectiveOptions);
    const firstScope = effectiveOptions.quotaScope
      ?? effectiveOptions.quotaScopes?.find((scope) => scope !== "unknown");
    const resetAt = firstScope && firstScope !== "unknown"
      ? scopedQuotaResetAt(profile, firstScope, now) ?? profile.quotaResetAt
      : profile.quotaResetAt;
    const disabledReason = (() => {
      if (runtimeStatus === "ready") return undefined;
      if (runtimeStatus === "mismatch") {
        return profile.credentialError
          ?? `expected ${profile.email ?? "-"}, got ${profile.verifiedEmail ?? "-"}`;
      }
      if (runtimeStatus === "error") {
        return profile.credentialError ?? "credential could not be verified";
      }
      if (runtimeStatus === "ineligible") {
        return profile.eligibilityReason
          ?? "account is not eligible for Antigravity; verify it in the browser or login another account";
      }
      if (runtimeStatus === "exhausted") {
        const exhaustedScope = exhaustedQuotaScopeForOptions(profile, effectiveOptions, now);
        const scopeText = exhaustedScope && exhaustedScope !== "unknown"
          ? `${exhaustedScope} quota`
          : "quota";
        return resetAt
          ? `${scopeText} resets ${relativeTime(resetAt, now)}`
          : "quota exhausted";
      }
      return "disabled";
    })();
    return {
      marker: profile.name === state.activeProfile ? "*" : "",
      number: String(index + 1),
      name: profile.name,
      expectedEmail: profile.email ?? "-",
      actualEmail: profile.verifiedEmail ?? "-",
      status: profileStatusText(profile, now, effectiveOptions),
      quotaReset: relativeTime(resetAt, now),
      lastRequest: relativeTime(profile.lastRequestAt, now),
      activated: relativeTime(profile.lastActivatedAt, now),
      verified: relativeTime(profile.credentialVerifiedAt ?? profile.credentialMismatchAt, now),
      switches: String(profile.selectionCount ?? 0),
      selectable,
      runtimeStatus,
      disabledReason,
      profile,
    };
  });
}
