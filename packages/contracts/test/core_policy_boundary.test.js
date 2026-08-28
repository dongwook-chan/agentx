import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentCliManifests,
  usageCheckPolicies,
  usageCheckReasons,
} from "@dong-/agentx-core";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cdxxSourceDir = join(repoRoot, "packages/cli/cdxx/src");

async function sourceFiles(directory, extension) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(directory, entry.name));
}

function scanCodexQuotaCalls(source) {
  return [...source.matchAll(/\bscanCodexQuota\s*\(\s*\{([\s\S]*?)\}\s*\)/g)]
    .map((match) => match[1]);
}

test("CLI usage reasons must be declared by core before adapter implementation", async () => {
  assert.deepEqual(Object.keys(usageCheckPolicies).sort(), Object.values(usageCheckReasons).sort());

  for (const file of await sourceFiles(cdxxSourceDir, ".js")) {
    const source = await readFile(file, "utf8");
    for (const call of scanCodexQuotaCalls(source)) {
      const reason = call.match(/\breason\s*:\s*([^,\n]+)/)?.[1];
      if (reason) {
        assert.match(
          reason,
          /usageCheckReasons\./,
          `${file} passes a product-owned usage reason to scanCodexQuota`,
        );
      }
    }
  }

  const quotaAdapter = await readFile(join(cdxxSourceDir, "quota.js"), "utf8");
  assert.match(
    quotaAdapter,
    /options\.reason\s*\?\?\s*usageCheckReasons\.explicitScan/,
    "cdxx quota adapter default must come from the core usage-reason registry",
  );
});

test("CLI adapters cannot put status probing back on the failover foreground path", async () => {
  const failover = await readFile(join(cdxxSourceDir, "failover_policy.js"), "utf8");
  assert.doesNotMatch(failover, /scanCodexQuota|probeCodexStatusQuota|refreshProfileStatus/);
  assert.match(failover, /startBackgroundProfileStatusRefresh/);

  const background = await readFile(join(cdxxSourceDir, "background_status.js"), "utf8");
  assert.match(background, /usageCheckReasons\.backgroundLiveQuotaRefresh/);
  assert.match(background, /detached:\s*true/);
  assert.match(background, /stdio:\s*["']ignore["']/);
  assert.match(background, /\.unref\?\.\(\)/);
});

test("both CLI adapters consume the shared live-quota decision", async () => {
  const agyx = await readFile(join(repoRoot, "packages/cli/agyx/src/coordinator.ts"), "utf8");
  const cdxx = await readFile(join(cdxxSourceDir, "failover_policy.js"), "utf8");
  assert.match(agyx, /decideLiveQuotaFailover/);
  assert.match(cdxx, /decideLiveQuotaFailover/);
});

test("both CLI adapters consume the shared credential persistence abstraction", async () => {
  const agyxCoordinator = await readFile(join(repoRoot, "packages/cli/agyx/src/coordinator.ts"), "utf8");
  const agyxCli = await readFile(join(repoRoot, "packages/cli/agyx/src/cli.ts"), "utf8");
  const cdxxAuth = await readFile(join(cdxxSourceDir, "auth.js"), "utf8");
  const cdxxStatus = await readFile(join(cdxxSourceDir, "status_probe.js"), "utf8");
  assert.match(agyxCoordinator, /persistCurrentCredential/);
  assert.match(agyxCli, /runRefreshableCredentialOperation/);
  assert.match(cdxxAuth, /persistCurrentCredential/);
  assert.match(cdxxStatus, /runRefreshableCredentialOperation/);
});

test("neither adapter launches a refresh-capable probe beside a live CLI session", async () => {
  const agyxSupervisor = await readFile(
    join(repoRoot, "packages/cli/agyx/native/agyx-supervisor/src/main.rs"),
    "utf8",
  );
  const cdxxSession = await readFile(join(cdxxSourceDir, "session.js"), "utf8");
  assert.doesNotMatch(agyxSupervisor, /_usage-probe/);
  assert.doesNotMatch(cdxxSession, /_status-probe-record/);
});

test("both CLI adapters preserve scope-less live exhaustion through core", async () => {
  const agyx = await readFile(join(repoRoot, "packages/cli/agyx/src/config.ts"), "utf8");
  const cdxx = await readFile(join(cdxxSourceDir, "quota.js"), "utf8");
  for (const source of [agyx, cdxx]) assert.match(source, /ensureExhaustedUsageScope/);
});

test("both CLI adapters delegate selection and resetless TTL to core", async () => {
  const agyxSelection = await readFile(join(repoRoot, "packages/cli/agyx/src/selection.ts"), "utf8");
  const cdxxSelection = await readFile(join(cdxxSourceDir, "selection.js"), "utf8");
  const agyxConfig = await readFile(join(repoRoot, "packages/cli/agyx/src/config.ts"), "utf8");
  const cdxxConfig = await readFile(join(cdxxSourceDir, "config.js"), "utf8");

  assert.match(agyxSelection, /selectAutoSwitchCandidate/);
  assert.match(cdxxSelection, /selectAutoSwitchCandidate/);
  assert.match(agyxConfig, /resetlessQuotaExpired/);
  assert.match(cdxxConfig, /resetlessQuotaExpired/);
  assert.doesNotMatch(agyxConfig, /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.doesNotMatch(cdxxConfig, /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
});

test("CLI capability differences are declared by the core manifest", async () => {
  assert.deepEqual(
    agentCliManifests.agy.quotaFailover.supportedEligibilityModes,
    ["allow", "block"],
  );
  assert.deepEqual(agentCliManifests.codex.quotaFailover.supportedEligibilityModes, []);
  assert.match(
    agentCliManifests.codex.quotaFailover.unsupportedEligibilityReason,
    /Codex auth and status data/,
  );

  const agyxConfig = await readFile(join(repoRoot, "packages/cli/agyx/src/config.ts"), "utf8");
  const agyxCli = await readFile(join(repoRoot, "packages/cli/agyx/src/cli.ts"), "utf8");
  const cdxxCli = await readFile(join(cdxxSourceDir, "cli.js"), "utf8");
  const cdxxUi = await readFile(join(cdxxSourceDir, "ui.js"), "utf8");
  assert.match(agyxConfig, /defaultEligibilityMode\s*===\s*["']allow["']/);
  assert.match(agyxCli, /quotaFailover\.supportedAutoSwitchModes/);
  assert.match(cdxxCli, /quotaFailover\.supportedAutoSwitchModes/);
  assert.match(cdxxCli, /quotaFailover\.unsupportedAutoSwitchModes/);
  assert.match(cdxxUi, /quotaFailover\.supportedAutoSwitchModes/);
});

test("both CLI adapters consume shared autoswitch action results", async () => {
  const agyx = await readFile(join(repoRoot, "packages/cli/agyx/src/coordinator.ts"), "utf8");
  const cdxx = await readFile(join(cdxxSourceDir, "failover_policy.js"), "utf8");
  assert.match(agyx, /AutoSwitchAction/);
  assert.match(cdxx, /stopRetryingAutoSwitch/);
});

test("both CLI adapters use the shared profile table and picker renderer", async () => {
  const agyx = await readFile(join(repoRoot, "packages/cli/agyx/src/ui.ts"), "utf8");
  const cdxx = await readFile(join(cdxxSourceDir, "ui.js"), "utf8");
  for (const source of [agyx, cdxx]) {
    assert.match(source, /renderAgentProfileTable/);
    assert.match(source, /pickAgentProfileAction/);
    assert.doesNotMatch(source, /new Table\s*\(/);
  }
});

test("both CLI adapters delegate unavailable manual-use confirmation to core", async () => {
  const agyxCli = await readFile(join(repoRoot, "packages/cli/agyx/src/cli.ts"), "utf8");
  const cdxxCli = await readFile(join(cdxxSourceDir, "cli.js"), "utf8");
  for (const source of [agyxCli, cdxxCli]) {
    assert.match(source, /decideExplicitProfileUse/);
  }
});

test("quota autoswitch uses the shared post-pause switching notice", async () => {
  const agyx = await readFile(join(repoRoot, "packages/cli/agyx/src/coordinator.ts"), "utf8");
  const cdxx = await readFile(join(cdxxSourceDir, "failover_policy.js"), "utf8");
  const cdxxSessions = await readFile(join(cdxxSourceDir, "managed_sessions.js"), "utf8");
  for (const source of [agyx, cdxx]) assert.match(source, /quotaSwitchingNotice/);
  for (const source of [agyx, cdxxSessions]) assert.match(source, /notify:/);
});

test("agy usage probing consumes the shared usage policy", async () => {
  const probe = await readFile(join(repoRoot, "packages/cli/agyx/src/usage_probe.ts"), "utf8");
  const cli = await readFile(join(repoRoot, "packages/cli/agyx/src/cli.ts"), "utf8");
  assert.match(probe, /runUsageCheck/);
  assert.match(probe, /usageCheckReasons\.explicitScan/);
  assert.match(cli, /usageCheckReasons\.sessionStart/);
  assert.match(cli, /usageCheckReasons\.manualRecord/);
});

test("unmanaged transcript recovery consumes the core observation contract", async () => {
  const watcher = await readFile(
    join(repoRoot, "packages/supervisor/src/codex_global_watcher.js"),
    "utf8",
  );
  assert.match(watcher, /agentCliManifests\.codex\.quotaFailover\.unmanagedTranscriptObservation/);
  assert.match(watcher, /observationPolicy\.maxReconcileDelayMs/);
  assert.match(watcher, /observationPolicy\.activeFileHorizonMs/);
  assert.match(watcher, /observationPolicy\.heartbeatIntervalMs/);
  assert.match(watcher, /observationPolicy\.recoveryDiagnoses/);
});
