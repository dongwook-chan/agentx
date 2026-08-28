import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLaunchPolicy,
  agentProfileColumnWidths,
  agentProfileHeaderLine,
  agentProfileRowLine,
  appendAgentEvent,
  clearExpiredProfileQuota,
  credentialLifecyclePolicy,
  decideExplicitProfileUse,
  decideObservedProfileFailover,
  decideLiveQuotaFailover,
  ensureExhaustedUsageScope,
  decideUseProfile,
  IncrementalFileTail,
  markActiveProfile,
  nativeSupervisorHostStatus,
  profileNameFromIdentity,
  quotaSwitchingNotice,
  readFirstLineBounded,
  persistCurrentCredential,
  resetlessQuotaExpired,
  renderAgentProfileTable,
  runAuthSwitchTransaction,
  runRefreshableCredentialOperation,
  runUsageCheck,
  SessionProfileOwnershipRegistry,
  selectAutoSwitchCandidate,
  selectRoundRobinProfile,
  shouldAutoSwitchForQuota,
  usageCheckPolicies,
  usageCheckReasons,
  uniqueProfileName,
  useProfileDisabledReason,
  usageCheckMode,
  unmanagedTranscriptObservationPolicy,
} from "../src/index.js";
import type { GenericProfileRecord } from "../src/index.js";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("appendAgentEvent writes JSONL records with timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-events-"));
  const path = join(root, "nested", "events.jsonl");
  try {
    await appendAgentEvent(path, {
      product: "testx",
      event: "switch.completed",
      fromProfile: "a",
      toProfile: "b",
    });
    const [line] = (await readFile(path, "utf8")).trim().split("\n");
    const record = JSON.parse(line!);
    assert.equal(record.product, "testx");
    assert.equal(record.event, "switch.completed");
    assert.equal(record.fromProfile, "a");
    assert.equal(record.toProfile, "b");
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("decideUseProfile opens a picker for any saved profile set", () => {
  assert.deepEqual(decideUseProfile([]), {
    type: "empty",
    message: "No saved profiles.",
  });

  assert.equal(decideUseProfile([
    { name: "dtjp_86", active: true, selectable: true },
  ]).type, "select");

  assert.equal(useProfileDisabledReason({
    name: "dtjp_86",
    active: true,
    selectable: true,
  }), "already active");
  assert.equal(decideUseProfile([
    { name: "a", selectable: false, disabledReason: "quota exhausted" },
  ]).type, "select");

  assert.equal(decideUseProfile([
    { name: "active", active: true, selectable: true },
    { name: "next", selectable: true },
  ]).type, "select");
});

test("explicit manual use confirms unavailable profiles instead of forbidding them", () => {
  assert.deepEqual(decideExplicitProfileUse({
    name: "ready",
    selectable: true,
  }), { type: "activate", force: false });
  assert.deepEqual(decideExplicitProfileUse({
    name: "active",
    active: true,
    selectable: false,
    disabledReason: "quota exhausted",
  }), { type: "already-active" });
  assert.deepEqual(decideExplicitProfileUse({
    name: "exhausted",
    selectable: false,
    disabledReason: "weekly quota exhausted",
  }), {
    type: "confirm",
    force: true,
    reason: "weekly quota exhausted",
    message: "Profile 'exhausted' is marked weekly quota exhausted. Switch anyway?",
    defaultValue: false,
  });
});

test("credential lifecycle persists mutable active credentials through one shared policy", async () => {
  assert.deepEqual(credentialLifecyclePolicy, {
    activeCredentialMayMutate: true,
    persistActiveBeforeReplacement: true,
    persistAfterRefreshCapableOperation: true,
    isolatedCredentialMutationsMustMergeBack: true,
    concurrentRefreshesAllowed: false,
  });

  let current = "access-old";
  const saved = new Map<string, string>();
  const adapter = {
    readCurrentCredential: async () => current,
    writeProfileCredential: async (name: string, credential: string) => {
      saved.set(name, credential);
    },
    credentialIsValid: (credential: string) => credential.startsWith("access-"),
  };

  assert.equal(await persistCurrentCredential(adapter, "one"), true);
  assert.equal(saved.get("one"), "access-old");

  const result = await runRefreshableCredentialOperation(adapter, "one", async () => {
    current = "access-refreshed";
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(saved.get("one"), "access-refreshed");
});

test("credential lifecycle preserves a refresh mutation when the provider operation fails", async () => {
  let current = "before";
  let saved: string | undefined;
  await assert.rejects(
    () => runRefreshableCredentialOperation({
      readCurrentCredential: async () => current,
      writeProfileCredential: async (_name: string, credential: string) => {
        saved = credential;
      },
    }, "one", async () => {
      current = "after-refresh";
      throw new Error("status request failed");
    }),
    /status request failed/,
  );
  assert.equal(saved, "after-refresh");
});

test("session ownership follows parent lineage without following later parent switches", () => {
  const ownership = new SessionProfileOwnershipRegistry();
  ownership.bind("parent", "account-a");
  assert.equal(ownership.inherit("child-a", "parent"), "account-a");

  ownership.bind("parent", "account-b");
  assert.equal(ownership.owner("parent"), "account-b");
  assert.equal(ownership.owner("child-a"), "account-a");
  assert.equal(ownership.inherit("child-b", "parent"), "account-b");
  assert.equal(ownership.inherit("orphan", "missing"), undefined);
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
  assert.equal(usageCheckMode("session-start"), "refresh");
  assert.equal(usageCheckMode("background-live-quota-refresh"), "refresh");
  assert.equal(usageCheckMode("session-exit"), "local-scan");
  assert.equal(usageCheckMode("list"), "state-only");
  assert.equal(usageCheckMode("use"), "state-only");
  assert.deepEqual(Object.keys(usageCheckPolicies).sort(), Object.values(usageCheckReasons).sort());

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
  assert.equal(
    (await runUsageCheck(adapter, "background-live-quota-refresh"))?.source,
    "remote",
  );
  assert.deepEqual(calls, [
    "refresh:explicit-scan",
    "local:session-exit",
    "refresh:background-live-quota-refresh",
  ]);
});

test("live quota failover never waits for usage metadata refresh", () => {
  assert.deepEqual(decideLiveQuotaFailover(true), {
    switchImmediately: true,
    usageRefreshMayBlock: false,
  });
  assert.deepEqual(decideLiveQuotaFailover(false), {
    switchImmediately: false,
    usageRefreshMayBlock: false,
  });
});

test("observed-profile failover suppresses stale concurrent quota events", () => {
  assert.deepEqual(decideObservedProfileFailover("account-a", "account-a"), {
    switchProfile: true,
    reason: "profile_matches",
  });
  assert.deepEqual(decideObservedProfileFailover("account-a", "account-b"), {
    switchProfile: false,
    reason: "profile_already_switched",
  });
  assert.deepEqual(decideObservedProfileFailover(undefined, "account-a"), {
    switchProfile: false,
    reason: "missing_observed_profile",
  });
  assert.deepEqual(decideObservedProfileFailover("account-a", undefined), {
    switchProfile: false,
    reason: "missing_active_profile",
  });
});

test("live quota exhaustion without explicit scope is preserved as unknown", () => {
  const checkedAt = "2026-08-07T04:29:18.580Z";
  const snapshot = ensureExhaustedUsageScope<"weekly" | "unknown">(
    {
      source: "live",
      exhausted: true,
      reason: "usage limit reached",
      scopes: {
        weekly: { status: "available", usedPercent: 0 },
      },
    },
    "unknown",
    checkedAt,
  );

  assert.deepEqual(snapshot.scopes?.unknown, {
    status: "exhausted",
    resetAt: undefined,
    reason: "usage limit reached",
    checkedAt,
  });
  assert.equal(snapshot.scopes?.weekly?.status, "available");
});

test("generic autoswitch policy supports scope-first and all-scopes modes", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const profile = {
    name: "active",
    quotaScopes: {
      claude: { status: "exhausted" as const },
      gemini: { status: "available" as const },
    },
  };
  const base = {
    triggerScope: "claude",
    switchableScopes: ["claude", "gemini"],
    candidateQuotaPolicy: "trigger-scope" as const,
    now,
  };

  assert.equal(shouldAutoSwitchForQuota(profile, { ...base, mode: "scope-first" }), true);
  assert.equal(shouldAutoSwitchForQuota(profile, { ...base, mode: "all-scopes" }), false);
  assert.equal(shouldAutoSwitchForQuota({
    ...profile,
    quotaScopes: {
      ...profile.quotaScopes,
      gemini: { status: "exhausted" },
    },
  }, { ...base, mode: "all-scopes" }), true);
  assert.equal(shouldAutoSwitchForQuota(profile, { ...base, mode: "off" }), false);
});

test("generic candidate selection is scope-aware and preserves rich ordering", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const state = {
    activeProfile: "a",
    profiles: [
      { name: "a", quotaScopes: { claude: { status: "exhausted" as const } } },
      {
        name: "b",
        quotaScopes: { gemini: { status: "exhausted" as const, resetAt: "2026-08-09T00:00:00.000Z" } },
      },
      {
        name: "c",
        quotaScopes: { gemini: { status: "exhausted" as const, resetAt: "2026-08-08T00:00:00.000Z" } },
      },
      { name: "d", eligibilityStatus: "ineligible" as const },
      { name: "e" },
    ],
  };
  const base = {
    mode: "all-scopes" as const,
    triggerScope: "claude",
    switchableScopes: ["claude", "gemini"],
    candidateQuotaPolicy: "trigger-scope" as const,
    now,
  };

  assert.equal(selectAutoSwitchCandidate(state, base)?.name, "d");
  assert.equal(selectAutoSwitchCandidate(state, {
    ...base,
    allowIneligibleActivation: false,
  })?.name, "e");
  state.profiles.pop();
  state.profiles.pop();
  assert.equal(selectAutoSwitchCandidate(state, base)?.name, "c");
  assert.equal(selectAutoSwitchCandidate(state, {
    ...base,
    mode: "scope-first",
    candidateQuotaPolicy: "any-scope",
  }), undefined);
});

test("generic round-robin and resetless quota TTL are core policy", () => {
  const state = {
    activeProfile: "b",
    profiles: [
      { name: "b" },
      { name: "a" },
      { name: "c", disabled: true },
    ],
  };
  assert.equal(selectRoundRobinProfile(state, (profile) => !profile.disabled)?.name, "a");
  assert.equal(
    resetlessQuotaExpired("2026-08-06T00:00:00.000Z", new Date("2026-08-07T00:00:00.000Z")),
    true,
  );
  assert.equal(resetlessQuotaExpired(undefined, new Date("2026-08-07T00:00:00.000Z")), false);
});

test("generic profile presentation renders shared table and picker rows", () => {
  const rows = [
    {
      id: "one",
      active: true,
      selectable: true,
      cells: {
        marker: "*",
        number: "1",
        name: "one",
        expectedEmail: "one@example.com",
        actualEmail: "one@example.com",
        status: "ready",
        quotaReset: "-",
        lastRequest: "1m ago",
        activated: "2m ago",
        verified: "3m ago",
        switches: "4",
      },
    },
  ];
  const widths = agentProfileColumnWidths(rows);
  assert.match(agentProfileHeaderLine(widths), /#  name\s+expected-email/);
  assert.match(agentProfileRowLine(rows[0]!, widths), /\*\s+1  one\s+one@example\.com/);
  assert.match(renderAgentProfileTable(rows), /│ \* │ 1 │ one\s+│ one@example\.com/);
});

test("quota switch transaction pauses all sessions before three-CRLF notice and operation", async () => {
  const events: string[] = [];
  const notice = quotaSwitchingNotice("cdxx");
  assert.equal(notice, "\r\n\r\n\r\n[cdxx] Quota detected; switching profiles...");
  const records = [{ id: "one" }, { id: "two" }];
  const result = await runAuthSwitchTransaction({
    sessionControl: {
      sessionRecords: async () => records,
      pause: async (record) => {
        events.push(`pause:${record.id}`);
        return { ...record, paused: true };
      },
      notify: async (record, message) => {
        assert.equal(message, notice);
        events.push(`notice:${record.id}`);
      },
      resume: async (record) => {
        events.push(`resume:${record.id}`);
      },
    },
  }, async () => {
    events.push("switch");
    return "done";
  }, { switchingNotice: notice });
  assert.equal(result, "done");
  assert.deepEqual(events, [
    "pause:one",
    "pause:two",
    "notice:one",
    "notice:two",
    "switch",
    "resume:one",
    "resume:two",
  ]);
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

test("unmanaged transcript observation treats notifications as hints with bounded recovery diagnostics", () => {
  assert.deepEqual(unmanagedTranscriptObservationPolicy, {
    changeNotifications: "hint",
    reconcileTrackedFileSizes: true,
    reconcileRecentSessionDirectories: true,
    activeFileHorizonMs: 172_800_000,
    maxReconcileDelayMs: 1_000,
    heartbeatIntervalMs: 30_000,
    recoveryDiagnoses: [
      "file_change_notification_missing",
      "new_file_notification_missing",
      "directory_watcher_missing",
      "notified_change_not_drained",
    ],
  });
});
