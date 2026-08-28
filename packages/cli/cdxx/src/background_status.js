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

function hasAuthoritativeQuotaWindow(summary) {
  return ["primary", "secondary", "monthly"].some((scope) =>
    summary?.statusRemaining?.[scope] !== undefined
    || summary?.current?.[scope] !== undefined
  );
}

/**
 * Probes every inactive candidate concurrently in an isolated CODEX_HOME, then
 * records the completed snapshots sequentially so concurrent state writes
 * cannot overwrite one another.
 */
export async function verifyProfileStatuses(profileNames, options = {}) {
  const scan = options.scan ?? scanCodexQuota;
  const record = options.record ?? recordQuotaForProfile;
  const names = [...new Set(profileNames.map(validateProfileName))];
  const probed = await Promise.all(names.map(async (name) => {
    try {
      const summary = await scan({
        reason: usageCheckReasons.automaticCandidateVerification,
        allowLocalFallback: false,
        statusOptions: {
          ...(options.statusOptions ?? {}),
          codexHome: join(profilesDir, name),
          profileName: name,
        },
      });
      if (summary?.source !== "status" || !hasAuthoritativeQuotaWindow(summary)) {
        throw new Error("Codex /status did not return a quota window");
      }
      return {
        profileName: name,
        status: summary.exhausted ? "exhausted" : "available",
        summary,
      };
    } catch (error) {
      return {
        profileName: name,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  for (const result of probed) {
    if (!result.summary) continue;
    try {
      await record(result.summary, result.profileName);
    } catch (error) {
      result.recordError = error instanceof Error ? error.message : String(error);
    }
  }
  return probed.map(({ summary: _summary, ...result }) => result);
}
