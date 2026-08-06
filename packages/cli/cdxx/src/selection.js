import { clearExpiredQuota } from "./config.js";

export function exhaustedQuotaScopes(profile) {
  clearExpiredQuota(profile);
  return Object.entries(profile.quotaScopes ?? {})
    .filter(([, quota]) => quota?.status === "exhausted")
    .map(([scope]) => scope);
}

export function profileSelectableReason(profile) {
  clearExpiredQuota(profile);
  if (profile.disabled) return "disabled";
  const exhausted = exhaustedQuotaScopes(profile);
  if (exhausted.length) return `quota exhausted: ${exhausted.join(",")}`;
  if (profile.quotaStatus === "exhausted") return "quota exhausted";
  return undefined;
}

export function isProfileSelectable(profile) {
  return !profileSelectableReason(profile);
}

export function pickNextProfile(state, currentName = state.activeProfile) {
  const profiles = [...state.profiles].sort((left, right) => left.name.localeCompare(right.name));
  if (!profiles.length) return undefined;
  for (const profile of profiles) clearExpiredQuota(profile);
  const start = profiles.findIndex((profile) => profile.name === currentName);
  // Never return the current profile: doing so reports a successful switch
  // while reinstalling the same exhausted credential.
  const candidateCount = start < 0 ? profiles.length : profiles.length - 1;
  for (let step = 1; step <= candidateCount; step += 1) {
    const candidate = profiles[(start + step + profiles.length) % profiles.length];
    if (!isProfileSelectable(candidate)) continue;
    return candidate;
  }
  return undefined;
}
