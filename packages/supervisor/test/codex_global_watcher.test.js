import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { CodexGlobalSessionWatcher } from "../src/codex_global_watcher.js";

const sessionId = "00000000-0000-0000-0000-000000000123";
const childSessionId = "00000000-0000-0000-0000-000000000456";

function line(type, payload) {
  return `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
}

function quotaFailure() {
  return line("event_msg", {
    type: "task_complete",
    error: {
      message: "You've hit your usage limit; try again later.",
      codex_error_info: "usage_limit_exceeded",
    },
  });
}

function inertWatchFactory(callbacks = new Map()) {
  return (directory, _options, callback) => {
    callbacks.set(directory, callback);
    return { on() { return this; }, close() {} };
  };
}

function utcSessionDirectory(sessionsDir, nowMs) {
  const date = new Date(nowMs);
  return join(
    sessionsDir,
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  );
}

async function waitForQuota(watcher, events) {
  const deadline = Date.now() + 2_000;
  while (!events.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.drain();
  }
}

test("global watcher ignores history and attributes appended quota to the turn-start profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-codex-"));
  const sessionsDir = join(root, "sessions");
  const file = join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const events = [];
  let activeProfile = "account-a";
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(file, quotaFailure());
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => activeProfile,
    onQuota: async (observation, quota) => events.push({ observation, quota }),
  });
  try {
    await watcher.start();
    watcher.markDirty(file);
    await watcher.drain();
    assert.equal(events.length, 0, "historical quota must start behind the initial offset");

    await appendFile(file, line("event_msg", { type: "task_started" }));
    watcher.markDirty(file);
    await watcher.drain();
    activeProfile = "account-b";
    await appendFile(file, quotaFailure());
    watcher.markDirty(file);
    await watcher.drain();

    assert.equal(events.length, 1);
    assert.equal(events[0].observation.profileName, "account-a");
    assert.equal(events[0].observation.sessionId, sessionId);
    assert.equal(events[0].quota.reachedType, "usage_limit_exceeded");
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global watcher leaves managed Codex sessions to their registered observer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-managed-"));
  const sessionsDir = join(root, "sessions");
  const file = join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const events = [];
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(file, line("session_meta", { id: sessionId }));
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => "account-a",
    isManagedSession: ({ sessionId: observed }) => observed === sessionId,
    onQuota: async (observation, quota) => events.push({ observation, quota }),
  });
  try {
    await watcher.start();
    await appendFile(file, line("event_msg", { type: "task_started" }) + quotaFailure());
    watcher.markDirty(file);
    await watcher.drain();
    assert.equal(events.length, 0);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global watcher ignores copied subagent history before its first live turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-subagent-"));
  const sessionsDir = join(root, "sessions");
  const parentFile = join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const childFile = join(sessionsDir, `rollout-${childSessionId}.jsonl`);
  const events = [];
  let activeProfile = "account-a";
  await mkdir(sessionsDir, { recursive: true });
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => activeProfile,
    onQuota: async (observation, quota) => events.push({ observation, quota }),
  });
  try {
    await watcher.start();
    await writeFile(
      parentFile,
      line("session_meta", { id: sessionId })
        + line("event_msg", { type: "task_started" }),
    );
    watcher.markDirty(parentFile);
    await watcher.drain();

    activeProfile = "account-b";
    await writeFile(childFile, line("session_meta", {
      id: childSessionId,
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: sessionId },
        },
      },
    }) + quotaFailure());
    watcher.markDirty(childFile);
    await watcher.drain();

    assert.equal(events.length, 0, "copied parent quota in the child preamble must be ignored");

    await appendFile(
      childFile,
      line("event_msg", { type: "task_started" }) + quotaFailure(),
    );
    watcher.markDirty(childFile);
    await watcher.drain();

    assert.equal(events.length, 1);
    assert.equal(events[0].observation.profileName, "account-a");
    assert.equal(events[0].observation.sessionId, childSessionId);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global watcher never charges an unattributed rollout to the current profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-unattributed-"));
  const sessionsDir = join(root, "sessions");
  const file = join(sessionsDir, `rollout-${childSessionId}.jsonl`);
  const events = [];
  await mkdir(sessionsDir, { recursive: true });
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => "account-b",
    onQuota: async (observation, quota) => events.push({ observation, quota }),
  });
  try {
    await watcher.start();
    await writeFile(file, line("session_meta", {
      id: childSessionId,
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: sessionId },
        },
      },
    }) + quotaFailure());
    watcher.markDirty(file);
    await watcher.drain();

    assert.equal(events.length, 0);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global watcher discovers new date directories without a full-tree poll", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-new-directory-"));
  const sessionsDir = join(root, "sessions");
  const directory = join(sessionsDir, "2026", "08", "13");
  const file = join(directory, `rollout-${sessionId}.jsonl`);
  const events = [];
  await mkdir(sessionsDir, { recursive: true });
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => "account-a",
    onQuota: async (observation, quota) => events.push({ observation, quota }),
  });
  try {
    await watcher.start();
    await mkdir(directory, { recursive: true });
    await writeFile(file, line("event_msg", { type: "task_started" }) + quotaFailure());
    await waitForQuota(watcher, events);

    assert.equal(events.length, 1);
    assert.equal(events[0].observation.profileName, "account-a");
    assert.equal(events[0].observation.sessionId, sessionId);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global watcher recovers an appended quota when the file notification is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-missed-append-"));
  const sessionsDir = join(root, "sessions");
  const file = join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const events = [];
  const diagnostics = [];
  let nowMs = Date.UTC(2026, 7, 28, 12, 0, 0);
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(file, line("session_meta", { id: sessionId }));
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => "account-a",
    onQuota: async (observation, quota) => events.push({ observation, quota }),
    onDiagnostic: async (event) => diagnostics.push(event),
    watchFactory: inertWatchFactory(),
    now: () => nowMs,
    reconcileIntervalMs: 1_000,
  });
  try {
    await watcher.start();
    await appendFile(file, line("event_msg", { type: "task_started" }) + quotaFailure());
    nowMs += 1_000;
    await watcher.drain();

    assert.equal(events.length, 1);
    assert.equal(events[0].observation.profileName, "account-a");
    const recovery = diagnostics.find((event) => event.event === "supervisor.global_watch.recovered");
    assert.equal(recovery?.diagnosis, "file_change_notification_missing");
    assert.equal(recovery?.transcriptPath, file);
    assert.ok(recovery?.actualSize > recovery?.previousOffset);
    assert.equal(watcher.diagnostics().recoveryCounts.file_change_notification_missing, 1);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global watcher recovers a new current-date tree when directory notifications are missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-missed-directory-"));
  const sessionsDir = join(root, "sessions");
  const events = [];
  const diagnostics = [];
  let nowMs = Date.UTC(2026, 7, 28, 12, 0, 0);
  await mkdir(sessionsDir, { recursive: true });
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => "account-a",
    onQuota: async (observation, quota) => events.push({ observation, quota }),
    onDiagnostic: async (event) => diagnostics.push(event),
    watchFactory: inertWatchFactory(),
    now: () => nowMs,
    reconcileIntervalMs: 1_000,
  });
  try {
    await watcher.start();
    const directory = utcSessionDirectory(sessionsDir, nowMs);
    const file = join(directory, `rollout-${sessionId}.jsonl`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      file,
      line("session_meta", { id: sessionId })
        + line("event_msg", { type: "task_started" })
        + quotaFailure(),
    );
    nowMs += 1_000;
    await watcher.drain();

    assert.equal(events.length, 1);
    assert.ok(diagnostics.some((event) => (
      event.event === "supervisor.global_watch.recovered"
      && event.diagnosis === "directory_watcher_missing"
    )));
    assert.ok(diagnostics.some((event) => (
      event.event === "supervisor.global_watch.recovered"
      && event.diagnosis === "new_file_notification_missing"
      && event.transcriptPath === file
    )));
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global watcher distinguishes a received notification that was not drained", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-undrained-"));
  const sessionsDir = join(root, "sessions");
  const file = join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const diagnostics = [];
  const callbacks = new Map();
  let nowMs = Date.UTC(2026, 7, 28, 12, 0, 0);
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(file, line("session_meta", { id: sessionId }));
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => "account-a",
    onQuota: async () => undefined,
    onDiagnostic: async (event) => diagnostics.push(event),
    watchFactory: inertWatchFactory(callbacks),
    now: () => nowMs,
    reconcileIntervalMs: 1_000,
  });
  try {
    await watcher.start();
    await appendFile(file, line("event_msg", { type: "task_started" }) + quotaFailure());
    callbacks.get(sessionsDir)("change", basename(file));
    watcher.dirty.clear();
    nowMs += 1_000;
    await watcher.drain();

    assert.ok(diagnostics.some((event) => (
      event.event === "supervisor.global_watch.recovered"
      && event.diagnosis === "notified_change_not_drained"
    )));
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global watcher heartbeat exposes root, liveness, offsets activity, and recovery counters", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-global-heartbeat-"));
  const sessionsDir = join(root, "sessions");
  const diagnostics = [];
  let nowMs = Date.UTC(2026, 7, 28, 12, 0, 0);
  await mkdir(sessionsDir, { recursive: true });
  const watcher = new CodexGlobalSessionWatcher({
    sessionsDir,
    getActiveProfile: async () => "account-a",
    onQuota: async () => undefined,
    onDiagnostic: async (event) => diagnostics.push(event),
    watchFactory: inertWatchFactory(),
    now: () => nowMs,
    heartbeatIntervalMs: 30_000,
  });
  try {
    await watcher.start();
    nowMs += 30_000;
    await watcher.drain();
    const heartbeat = diagnostics.find((event) => event.event === "supervisor.global_watch.heartbeat");
    assert.equal(heartbeat?.active, true);
    assert.equal(heartbeat?.sessionsDir, sessionsDir);
    assert.equal(heartbeat?.changeNotifications, "hint");
    assert.equal(heartbeat?.reconcileIntervalMs, 1_000);
    assert.equal(heartbeat?.activeFileHorizonMs, 172_800_000);
    assert.equal(typeof heartbeat?.watcherCount, "number");
    assert.equal(typeof heartbeat?.trackedFileCount, "number");
    assert.equal(typeof heartbeat?.reconcileCount, "number");
    assert.equal(typeof heartbeat?.lastReconcileDurationMs, "number");
    assert.equal(typeof heartbeat?.lastReconciledFileCount, "number");
    assert.equal(typeof heartbeat?.lastRecentDirectoryCount, "number");
    assert.deepEqual(Object.keys(heartbeat?.recoveryCounts ?? {}).sort(), [
      "directory_watcher_missing",
      "file_change_notification_missing",
      "new_file_notification_missing",
      "notified_change_not_drained",
    ]);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});
