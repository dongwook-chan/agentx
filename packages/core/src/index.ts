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
