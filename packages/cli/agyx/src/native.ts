import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runLauncher } from "@dong-/agentx-supervisor";
import {
  nativeSupervisorBinaryName as coreNativeSupervisorBinaryName,
  nativeSupervisorHostStatus as coreNativeSupervisorHostStatus,
  NativeSupervisorHostStatus,
} from "@dong-/agentx-core";
import { findRealAgy, isRestartable } from "./processes.js";
import { buildAgyLaunchArgs } from "./launch_args.js";
import { loadState } from "./config.js";

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
  const realAgy = await findRealAgy();
  const policyCommand = fileURLToPath(new URL("./cli.js", import.meta.url));
  return await runLauncher({
    product: "agyx",
    executable: realAgy,
    args,
    policyCommand,
    restartable: isRestartable(args),
    buildArgs: async ({ record, logPath }: {
      record: { conversationId?: string };
      logPath?: string;
    }) => buildAgyLaunchArgs(args, {
      conversationId: record.conversationId,
      logPath: logPath ?? "",
      state: await loadState(),
    }),
  });
}
