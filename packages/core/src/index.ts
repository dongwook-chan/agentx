export interface LaunchPolicy {
  productName: string;
  yoloEnabled: boolean;
  yoloFlag: string;
  foreignYoloFlags: readonly string[];
  foreignFlagLabel: string;
}

function hasArg(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function applyLaunchPolicy(
  args: readonly string[],
  policy: LaunchPolicy,
): string[] {
  for (const flag of policy.foreignYoloFlags) {
    if (hasArg(args, flag)) {
      throw new Error(
        `${flag} is a ${policy.foreignFlagLabel} option. For ${policy.productName} use ${policy.yoloFlag}.`,
      );
    }
  }

  const result = [...args];
  if (policy.yoloEnabled && !hasArg(result, policy.yoloFlag)) {
    result.unshift(policy.yoloFlag);
  }
  return result;
}

export interface UseProfileCandidate {
  name: string;
  active?: boolean;
  selectable: boolean;
  disabledReason?: string;
}

export type UseProfileDecision =
  | { type: "empty"; message: "No saved profiles." }
  | { type: "none"; message: string; reason: "active_only" | "no_selectable" }
  | { type: "select"; candidates: UseProfileCandidate[] };

export function useProfileDisabledReason(
  candidate: UseProfileCandidate,
): string | undefined {
  if (candidate.active) return "already active";
  if (!candidate.selectable) return candidate.disabledReason ?? "not selectable";
  return undefined;
}

export function decideUseProfile(
  candidates: readonly UseProfileCandidate[],
): UseProfileDecision {
  if (!candidates.length) return { type: "empty", message: "No saved profiles." };

  const selectable = candidates.filter((candidate) => !useProfileDisabledReason(candidate));
  if (selectable.length) {
    return { type: "select", candidates: [...candidates] };
  }

  const active = candidates.find((candidate) => candidate.active);
  if (active) {
    return {
      type: "none",
      reason: "active_only",
      message: `'${active.name}' is already active.`,
    };
  }

  return {
    type: "none",
    reason: "no_selectable",
    message: "No selectable profile found.",
  };
}
