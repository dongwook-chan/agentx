import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  nativeSupervisorBinaryName as coreNativeSupervisorBinaryName,
  nativeSupervisorHostStatus as coreNativeSupervisorHostStatus,
} from "@dong-/agentx-core";

export const nativeSupervisorBinaryByHost = {
  "darwin:arm64": "cdxx-supervisor-darwin-arm64",
  "linux:arm64": "cdxx-supervisor-linux-arm64",
};

export function nativeSupervisorBinaryName(
  platform = process.platform,
  arch = process.arch,
) {
  return coreNativeSupervisorBinaryName(nativeSupervisorBinaryByHost, platform, arch);
}

export function nativeSupervisorHostStatus(
  platform = process.platform,
  arch = process.arch,
) {
  return coreNativeSupervisorHostStatus(
    "cdxx",
    nativeSupervisorBinaryByHost,
    "darwin/arm64 or linux/arm64",
    platform,
    arch,
  );
}

export function nativeSupervisorPath() {
  const binaryName = nativeSupervisorBinaryName();
  if (!binaryName) throw new Error(nativeSupervisorHostStatus().message);
  return fileURLToPath(new URL(`../bin/${binaryName}`, import.meta.url));
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runNativeSupervisor(args, realCodex) {
  const host = nativeSupervisorHostStatus();
  if (!host.supported) {
    throw new Error(host.message);
  }

  const binary = nativeSupervisorPath();
  if (!await executable(binary)) {
    throw new Error(`Native supervisor binary not found: ${binary}. Run 'npm run build:native'.`);
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: {
        ...process.env,
        CDXX_REAL_CODEX: realCodex,
        CDXX_CLI_PATH: fileURLToPath(new URL("./cli.js", import.meta.url)),
        CDXX_NODE_PATH: process.execPath,
      },
    });
    const previousListeners = new Map();
    let interruptedSignal;
    const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
    const cleanup = () => {
      for (const [signal, listeners] of previousListeners) {
        process.removeAllListeners(signal);
        for (const listener of listeners) process.on(signal, listener);
      }
    };
    const installSignalHandler = (signal) => {
      previousListeners.set(signal, process.listeners(signal));
      process.removeAllListeners(signal);
      process.on(signal, () => {
        interruptedSignal = signal;
        if (child.exitCode === null && !child.killed) child.kill(signal);
      });
    };
    for (const signal of Object.keys(signalNumbers)) installSignalHandler(signal);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      cleanup();
      const exitSignal = signal ?? interruptedSignal;
      resolve(code ?? (exitSignal ? 128 + (signalNumbers[exitSignal] ?? 0) : 1));
    });
  });
}
