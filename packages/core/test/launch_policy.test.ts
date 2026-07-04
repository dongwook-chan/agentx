import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLaunchPolicy,
  clearExpiredProfileQuota,
  decideUseProfile,
  IncrementalFileTail,
  markActiveProfile,
  nativeSupervisorHostStatus,
  profileNameFromIdentity,
  readFirstLineBounded,
  runUsageCheck,
  uniqueProfileName,
  useProfileDisabledReason,
  usageCheckMode,
} from "../src/index.js";
import type { GenericProfileRecord } from "../src/index.js";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface TestProfile extends GenericProfileRecord {
  previousNames?: string[];
}

test("applyLaunchPolicy injects yolo flag exactly once", () => {
  const args = applyLaunchPolicy(["resume", "abc"], {
    productName: "Codex",
    yoloEnabled: true,
    yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
    foreignYoloFlags: ["--dangerously-skip-permissions"],
    foreignFlagLabel: "agy",
  });

  assert.deepEqual(args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "resume",
    "abc",
  ]);
  assert.deepEqual(applyLaunchPolicy(args, {
    productName: "Codex",
    yoloEnabled: true,
    yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
    foreignYoloFlags: ["--dangerously-skip-permissions"],
    foreignFlagLabel: "agy",
  }), args);
});

test("applyLaunchPolicy honors yolo off and rejects foreign yolo flags", () => {
  assert.deepEqual(applyLaunchPolicy(["resume", "abc"], {
    productName: "agy",
    yoloEnabled: false,
    yoloFlag: "--dangerously-skip-permissions",
    foreignYoloFlags: ["--dangerously-bypass-approvals-and-sandbox"],
    foreignFlagLabel: "Codex",
  }), ["resume", "abc"]);

  assert.throws(
    () => applyLaunchPolicy(["--dangerously-bypass-approvals-and-sandbox"], {
      productName: "agy",
      yoloEnabled: true,
      yoloFlag: "--dangerously-skip-permissions",
      foreignYoloFlags: ["--dangerously-bypass-approvals-and-sandbox"],
      foreignFlagLabel: "Codex",
    }),
    /Codex option/,
  );
});

test("decideUseProfile exits active-only profile sets without opening a picker", () => {
  assert.deepEqual(decideUseProfile([]), {
    type: "empty",
    message: "No saved profiles.",
  });

  assert.deepEqual(decideUseProfile([
    { name: "dtjp_86", active: true, selectable: true },
  ]), {
    type: "none",
    reason: "active_only",
    message: "'dtjp_86' is already active.",
  });

  assert.equal(useProfileDisabledReason({
    name: "dtjp_86",
    active: true,
    selectable: true,
  }), "already active");
});

test("decideUseProfile selects only when a non-active selectable candidate exists", () => {
  assert.deepEqual(decideUseProfile([
    { name: "a", selectable: false, disabledReason: "quota exhausted" },
  ]), {
    type: "none",
    reason: "no_selectable",
    message: "No selectable profile found.",
  });

  assert.equal(decideUseProfile([
    { name: "active", active: true, selectable: true },
    { name: "next", selectable: true },
  ]).type, "select");
});

test("profile primitives normalize names, aliases, activation, and expired quota", () => {
  const state: { activeProfile?: string; profiles: TestProfile[] } = {
    activeProfile: undefined,
    profiles: [
      { name: "work", previousNames: ["old-work"], quotaStatus: "available" as const },
      {
        name: "next",
        quotaStatus: "exhausted" as const,
        quotaResetAt: "2026-01-01T00:00:00.000Z",
        lastQuotaReason: "quota",
      },
    ],
  };

  assert.equal(profileNameFromIdentity("User.Name+test@example.com"), "user.name-test");
  assert.equal(uniqueProfileName("old-work", state, {
    aliases: (profile) => profile.previousNames,
  }), "old-work-2");

  markActiveProfile(state, "next", { now: new Date("2026-02-01T00:00:00.000Z") });
  assert.equal(state.activeProfile, "next");
  assert.equal(state.profiles[1]!.selectionCount, 1);
  assert.equal(state.profiles[1]!.quotaStatus, "available");
  assert.equal(state.profiles[1]!.lastQuotaReason, undefined);

  const profile = {
    name: "quota",
    quotaStatus: "exhausted" as const,
    quotaResetAt: "2026-01-01T00:00:00.000Z",
  };
  clearExpiredProfileQuota(profile, new Date("2026-02-01T00:00:00.000Z"));
  assert.equal(profile.quotaStatus, "available");
});

test("native supervisor host status is shared and product-specific", () => {
  assert.deepEqual(
    nativeSupervisorHostStatus("cdxx", { "linux:arm64": "cdxx-supervisor-linux-arm64" }, "linux/arm64", "linux", "arm64"),
    {
      supported: true,
      platform: "linux",
      arch: "arm64",
      expected: "linux/arm64",
      binaryName: "cdxx-supervisor-linux-arm64",
      message: undefined,
    },
  );

  assert.match(
    nativeSupervisorHostStatus("agyx", {}, "linux/arm64", "freebsd", "x64").message ?? "",
    /agyx native supervisor supports linux\/arm64 only/,
  );
});

test("usage policy centralizes refresh, local-scan, and state-only conditions", async () => {
  assert.equal(usageCheckMode("explicit-scan"), "refresh");
  assert.equal(usageCheckMode("manual-record"), "refresh");
  assert.equal(usageCheckMode("live-quota-trigger"), "refresh");
  assert.equal(usageCheckMode("session-exit"), "local-scan");
  assert.equal(usageCheckMode("list"), "state-only");
  assert.equal(usageCheckMode("use"), "state-only");

  const calls: string[] = [];
  const adapter = {
    refreshUsage: async (reason: string) => {
      calls.push(`refresh:${reason}`);
      return { source: "remote", exhausted: false };
    },
    scanLocalUsage: async (reason: string) => {
      calls.push(`local:${reason}`);
      return { source: "local", exhausted: false };
    },
  };

  assert.equal((await runUsageCheck(adapter, "explicit-scan"))?.source, "remote");
  assert.equal((await runUsageCheck(adapter, "session-exit"))?.source, "local");
  assert.equal(await runUsageCheck(adapter, "list"), undefined);
  assert.deepEqual(calls, ["refresh:explicit-scan", "local:session-exit"]);
});

test("readFirstLineBounded reads only the first line prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-core-tail-"));
  try {
    const file = join(root, "large.log");
    await writeFile(file, `first\n${"x".repeat(128 * 1024)}`);

    assert.deepEqual(await readFirstLineBounded(file, { maxBytes: 1024 }), {
      line: "first",
      truncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("IncrementalFileTail reads only appended complete lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-core-tail-"));
  try {
    const file = join(root, "tail.log");
    await writeFile(file, "old\npartial");
    const tail = new IncrementalFileTail(file, { offset: Buffer.byteLength("old\n") });

    assert.equal(await tail.readAdded(), undefined);
    await appendFile(file, " line\nnext");
    assert.deepEqual((await tail.readAdded())?.lines, ["partial line"]);
    await appendFile(file, " line\n");
    assert.deepEqual((await tail.readAdded())?.lines, ["next line"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
