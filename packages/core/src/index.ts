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

export interface LoginSemantics {
  command: readonly string[];
  clearsActiveCredentialAtStart: boolean;
  requiresActiveSlotClearedBeforeLogin: boolean;
  mustRestorePreviousActiveOnFailure: boolean;
  successRequiresCredentialValidation: boolean;
}

export interface CredentialSemantics {
  activeLocations: readonly string[];
  savedProfileLocation: string;
}

export interface AgentCliManifest {
  id: "agy" | "codex";
  packageName: string;
  executable: string;
  login: LoginSemantics;
  credentials: CredentialSemantics;
}

export const agentCliManifests = {
  agy: {
    id: "agy",
    packageName: "agyx",
    executable: "agy",
    login: {
      command: [],
      clearsActiveCredentialAtStart: false,
      requiresActiveSlotClearedBeforeLogin: true,
      mustRestorePreviousActiveOnFailure: true,
      successRequiresCredentialValidation: true,
    },
    credentials: {
      activeLocations: [
        "~/.gemini/antigravity-cli/antigravity-oauth-token",
        "legacy macOS Keychain gemini/antigravity",
      ],
      savedProfileLocation: "agyx credential vault by profile name",
    },
  },
  codex: {
    id: "codex",
    packageName: "@dong-/cdxx",
    executable: "codex",
    login: {
      command: ["login"],
      clearsActiveCredentialAtStart: true,
      requiresActiveSlotClearedBeforeLogin: false,
      mustRestorePreviousActiveOnFailure: true,
      successRequiresCredentialValidation: true,
    },
    credentials: {
      activeLocations: [
        "$CODEX_HOME/auth.json",
        "~/.codex/auth.json",
      ],
      savedProfileLocation: "cdxx profiles directory by profile name",
    },
  },
} as const satisfies Record<string, AgentCliManifest>;
