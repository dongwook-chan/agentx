import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  refreshProfileStatus,
  startBackgroundProfileStatusRefresh,
  verifyProfileStatuses,
} from "../src/background_status.js";
import { profilesDir } from "../src/config.js";

test("background profile refresh launches detached without inherited stdio", () => {
  let invocation;
  let unrefCalled = false;
  const pid = startBackgroundProfileStatusRefresh("profile-a", {
    execPath: "/node",
    cliPath: "/cli.js",
    cwd: "/workspace",
    env: { TEST: "1" },
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return {
        pid: 123,
        on: () => undefined,
        unref: () => { unrefCalled = true; },
      };
    },
  });

  assert.equal(pid, 123);
  assert.equal(unrefCalled, true);
  assert.deepEqual(invocation, {
    command: "/node",
    args: ["/cli.js", "_status-probe-profile-record", "profile-a"],
    options: {
      cwd: "/workspace",
      env: { TEST: "1" },
      detached: true,
      stdio: "ignore",
    },
  });
});

test("profile refresh probes and records the requested saved profile", async () => {
  const summary = { source: "status", exhausted: true, resetAt: "2026-08-08T00:00:00.000Z" };
  let scanOptions;
  let recorded;

  const result = await refreshProfileStatus("profile-a", {
    statusOptions: { timeoutMs: 25 },
    scan: async (options) => {
      scanOptions = options;
      return summary;
    },
    record: async (value, name) => { recorded = { value, name }; },
  });

  assert.equal(result, summary);
  assert.deepEqual(scanOptions, {
    reason: "background-live-quota-refresh",
    allowLocalFallback: false,
    statusOptions: {
      timeoutMs: 25,
      codexHome: join(profilesDir, "profile-a"),
      profileName: "profile-a",
    },
  });
  assert.deepEqual(recorded, { value: summary, name: "profile-a" });
});

test("candidate verification probes all profiles before recording snapshots", async () => {
  const calls = [];
  const recorded = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = verifyProfileStatuses(["profile-a", "profile-b"], {
    scan: async (options) => {
      calls.push(options);
      await gate;
      const exhausted = options.statusOptions.profileName === "profile-b";
      return {
        source: "status",
        exhausted,
        statusRemaining: { primary: exhausted ? 0 : 50 },
        current: { primary: exhausted ? 100 : 50 },
      };
    },
    record: async (summary, profileName) => recorded.push({ summary, profileName }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2, "all isolated probes must start concurrently");
  release();

  assert.deepEqual(await pending, [
    { profileName: "profile-a", status: "available" },
    { profileName: "profile-b", status: "exhausted" },
  ]);
  assert.deepEqual(calls.map((call) => call.reason), [
    "automatic-candidate-verification",
    "automatic-candidate-verification",
  ]);
  assert.deepEqual(recorded.map((entry) => entry.profileName), ["profile-a", "profile-b"]);
});

test("candidate verification reports missing quota windows as failure", async () => {
  const result = await verifyProfileStatuses(["profile-a"], {
    scan: async () => ({ source: "status", exhausted: false, current: {} }),
    record: async () => assert.fail("invalid status must not be recorded"),
  });

  assert.equal(result[0].profileName, "profile-a");
  assert.equal(result[0].status, "failed");
  assert.match(result[0].reason, /did not return a quota window/);
});
