import { clearExpiredQuota } from "./config.js";
import { agentCliManifests, selectAutoSwitchCandidate } from "@dong-/agentx-core";

export const codexQuotaScopes = ["5h", "weekly", "monthly"];

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

export function pickNextProfile(
  state,
  currentName = state.activeProfile,
  triggerScope = "unknown",
  mode = agentCliManifests.codex.quotaFailover.supportedAutoSwitchModes.find((value) => value !== "off"),
) {
  for (const profile of state.profiles) clearExpiredQuota(profile);
  return selectAutoSwitchCandidate({ ...state, activeProfile: currentName }, {
    mode,
    triggerScope,
    switchableScopes: codexQuotaScopes,
    candidateQuotaPolicy: agentCliManifests.codex.quotaFailover.candidateQuotaPolicy,
    unknownScope: "unknown",
  });
}
