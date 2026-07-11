import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runNativeSupervisor } from "./native.js";
import { findRealCodex, isInteractiveCodex } from "./processes.js";
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
  if (
    isInteractiveCodex(args)
    && process.env.CDXX_DISABLE_STARTUP_STATUS_PROBE !== "1"
  ) {
    startStatusProbeRecord();
  }
  return await runNativeSupervisor(args, await findRealCodex());
}
