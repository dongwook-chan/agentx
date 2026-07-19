import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLauncher } from "@dong-/agentx-supervisor";
import { findRealCodex, isInteractiveCodex } from "./processes.js";
import { buildCodexLaunchArgsFromState } from "./launch_args.js";
export { pickNextProfile } from "./selection.js";

function startStatusProbeRecord() {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./cli.js", import.meta.url)),
    "_status-probe-record",
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

export async function runCodexSession(args) {
  const policyCommand = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (
    isInteractiveCodex(args)
    && process.env.CDXX_DISABLE_STARTUP_STATUS_PROBE !== "1"
  ) {
    startStatusProbeRecord();
  }
  const realCodex = await findRealCodex();
  if (!isInteractiveCodex(args)) {
    return await runLauncher({
      product: "cdxx",
      executable: realCodex,
      args,
      policyCommand,
      restartable: false,
      buildArgs: async () => await buildCodexLaunchArgsFromState(args),
    });
  }
  return await runLauncher({
    product: "cdxx",
    executable: realCodex,
    args,
    policyCommand,
    buildArgs: async ({ record }) => await buildCodexLaunchArgsFromState(
      record.codexSessionId ? ["resume", record.codexSessionId] : args,
    ),
  });
}
