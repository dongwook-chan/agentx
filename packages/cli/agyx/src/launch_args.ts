import { applyLaunchPolicy } from "@dong-/agentx-core";
import { effectiveYoloMode, State } from "./config.js";
import { withConversation } from "./processes.js";

export const agyTargetCapabilities = {
  yoloFlag: "--dangerously-skip-permissions",
  foreignYoloFlags: ["--dangerously-bypass-approvals-and-sandbox"],
} as const;

export interface AgyLaunchOptions {
  conversationId?: string;
  logPath: string;
  state: Pick<State, "settings">;
}

export function buildAgyLaunchArgs(
  args: string[],
  options: AgyLaunchOptions,
): string[] {
  const launchArgs = withConversation(args, options.conversationId);
  if (!launchArgs.some((argument) =>
    argument === "--log-file" || argument.startsWith("--log-file=")
  )) {
    launchArgs.push("--log-file", options.logPath);
  }
  return applyLaunchPolicy(launchArgs, {
    productName: "agy",
    yoloEnabled: effectiveYoloMode(options.state),
    yoloFlag: agyTargetCapabilities.yoloFlag,
    foreignYoloFlags: agyTargetCapabilities.foreignYoloFlags,
    foreignFlagLabel: "Codex",
  });
}
