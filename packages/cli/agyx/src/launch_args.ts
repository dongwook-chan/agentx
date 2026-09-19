import { applyLaunchPolicy } from "@dong-/agentx-core";
import { effectiveYoloMode, State } from "./config.js";
import { withConversation } from "./processes.js";

export const agyTargetCapabilities = {
  yoloFlag: "--dangerously-skip-permissions",
  foreignYoloFlags: ["--dangerously-bypass-approvals-and-sandbox"],
} as const;

export interface AgyLaunchOptions {
  conversationId?: string;
  resumePrompt?: string;
  logPath: string;
  state: Pick<State, "settings">;
}

export function withAgyResumePrompt(
  args: string[],
  resumePrompt?: string,
): string[] {
  if (!resumePrompt) return [...args];
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-i" || argument === "--prompt-interactive") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--prompt-interactive=")) continue;
    result.push(argument);
  }
  return [...result, "--prompt-interactive", resumePrompt];
}

export function buildAgyLaunchArgs(
  args: string[],
  options: AgyLaunchOptions,
): string[] {
  const launchArgs = withAgyResumePrompt(
    withConversation(args, options.conversationId),
    options.resumePrompt,
  );
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
