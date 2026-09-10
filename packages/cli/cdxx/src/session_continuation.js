import { spawn } from "node:child_process";
import { buildCodexLaunchArgsFromState } from "./launch_args.js";
import { findRealCodex } from "./processes.js";

export function codexContinuationArgs(sessionId, prompt) {
  return ["exec", "resume", "--all", sessionId, prompt];
}

export async function startCodexSessionContinuation({ sessionId, prompt }, options = {}) {
  const executable = await (options.findExecutable ?? findRealCodex)();
  const args = await (options.buildArgs ?? buildCodexLaunchArgsFromState)(
    codexContinuationArgs(sessionId, prompt),
  );
  const child = (options.spawnProcess ?? spawn)(executable, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return { pid: child.pid };
}
