import { applyLaunchPolicy } from "@dong-/agentx-core";
import { effectiveYoloMode, loadState } from "./config.js";

export const codexTargetCapabilities = {
  yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
  foreignYoloFlags: ["--dangerously-skip-permissions"],
};

export function buildCodexLaunchArgs(args, state) {
  return applyLaunchPolicy(args, {
    productName: "Codex",
    yoloEnabled: effectiveYoloMode(state),
    yoloFlag: codexTargetCapabilities.yoloFlag,
    foreignYoloFlags: codexTargetCapabilities.foreignYoloFlags,
    foreignFlagLabel: "agy",
  });
}

export async function buildCodexLaunchArgsFromState(args) {
  return buildCodexLaunchArgs(args, await loadState());
}
