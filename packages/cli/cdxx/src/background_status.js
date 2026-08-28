import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { usageCheckReasons } from "@dong-/agentx-core";
import { profilesDir, validateProfileName } from "./config.js";
import { recordQuotaForProfile, scanCodexQuota } from "./quota.js";

export function startBackgroundProfileStatusRefresh(profileName, options = {}) {
  const name = validateProfileName(profileName);
  const executable = options.execPath ?? process.execPath;
  const cliPath = options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
  const launch = options.spawn ?? spawn;
  const child = launch(executable, [cliPath, "_status-probe-profile-record", name], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    detached: true,
    stdio: "ignore",
  });
  child.on?.("error", () => undefined);
  child.unref?.();
  return child.pid;
}

export async function refreshProfileStatus(profileName, options = {}) {
  const name = validateProfileName(profileName);
  const scan = options.scan ?? scanCodexQuota;
  const record = options.record ?? recordQuotaForProfile;
  const summary = await scan({
    reason: usageCheckReasons.backgroundLiveQuotaRefresh,
    allowLocalFallback: false,
    statusOptions: {
      ...(options.statusOptions ?? {}),
      codexHome: join(profilesDir, name),
      profileName: name,
    },
  });
  await record(summary, name);
  return summary;
}
