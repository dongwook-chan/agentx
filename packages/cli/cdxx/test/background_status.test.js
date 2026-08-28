import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  refreshProfileStatus,
  startBackgroundProfileStatusRefresh,
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
