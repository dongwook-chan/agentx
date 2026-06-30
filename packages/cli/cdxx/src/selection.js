import { clearExpiredQuota } from "./config.js";

export function pickNextProfile(state, currentName = state.activeProfile) {
  const profiles = [...state.profiles].sort((left, right) => left.name.localeCompare(right.name));
  if (!profiles.length) return undefined;
  for (const profile of profiles) clearExpiredQuota(profile);
  const start = profiles.findIndex((profile) => profile.name === currentName);
  for (let step = 1; step <= profiles.length; step += 1) {
    const candidate = profiles[(start + step + profiles.length) % profiles.length];
    if (candidate.disabled) continue;
    if (candidate.quotaStatus === "exhausted") continue;
    return candidate;
  }
  return undefined;
}
