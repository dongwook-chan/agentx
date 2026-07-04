import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  nativeSupervisorBinaryName as coreNativeSupervisorBinaryName,
  nativeSupervisorHostStatus as coreNativeSupervisorHostStatus,
  NativeSupervisorHostStatus,
} from "@dong-/agentx-core";

export const nativeSupervisorBinaryByHost = {
  "darwin:arm64": "agyx-supervisor-darwin-arm64",
  "linux:arm64": "agyx-supervisor-linux-arm64",
} as const;

export type NativeSupervisorHost = keyof typeof nativeSupervisorBinaryByHost;

export function nativeSupervisorBinaryName(
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  return coreNativeSupervisorBinaryName(nativeSupervisorBinaryByHost, platform, arch);
}

export function nativeSupervisorHostStatus(
  platform = process.platform,
  arch = process.arch,
): NativeSupervisorHostStatus {
  return coreNativeSupervisorHostStatus(
    "agyx",
    nativeSupervisorBinaryByHost,
    "darwin/arm64 or linux/arm64",
    platform,
    arch,
  );
}

export function nativeSupervisorPath(): string {
  const binaryName = nativeSupervisorBinaryName();
  if (!binaryName) {
    throw new Error(nativeSupervisorHostStatus().message);
  }
  return fileURLToPath(new URL(`../../bin/${binaryName}`, import.meta.url));
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runNativeSupervisor(args: string[]): Promise<number> {
  const host = nativeSupervisorHostStatus();
  if (!host.supported) {
    throw new Error(host.message);
  }

  const binary = nativeSupervisorPath();
  if (!await executable(binary)) {
    throw new Error(
      `Native supervisor binary not found: ${binary}. Run 'npm run build:native'.`,
    );
  }

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        AGYX_CLI_PATH: fileURLToPath(new URL("./cli.js", import.meta.url)),
        AGYX_NODE_PATH: process.execPath,
      },
    });
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });
}
