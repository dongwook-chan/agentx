import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SupervisorDaemon } from "../src/daemon.js";
import { sendSupervisor } from "../src/client.js";
import { registerCodexHook } from "../src/hook.js";

test("SessionStart hook binds exact Codex session id and transcript to launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-supervisor-hook-"));
  const socketPath = join(root, "supervisor.sock");
  const daemon = new SupervisorDaemon({ socketPath, statePath: join(root, "state.json") });
  await daemon.start();
  try {
    await sendSupervisor({
      command: "register",
      product: "cdxx",
      launcherId: "launch-1",
      launcherPid: process.pid,
      childPid: process.pid,
      cwd: "/tmp/project",
      args: [],
    }, { socketPath });
    const previousSocket = process.env.AGENTX_SUPERVISOR_SOCKET;
    process.env.AGENTX_SUPERVISOR_SOCKET = socketPath;
    try {
      await registerCodexHook({
        hook_event_name: "SessionStart",
        session_id: "00000000-0000-0000-0000-000000000123",
        transcript_path: join(root, "rollout.jsonl"),
        cwd: "/tmp/project",
      }, { CDXX_LAUNCHER_ID: "launch-1" });
    } finally {
      if (previousSocket === undefined) delete process.env.AGENTX_SUPERVISOR_SOCKET;
      else process.env.AGENTX_SUPERVISOR_SOCKET = previousSocket;
    }
    const sessions = await sendSupervisor({ command: "sessions" }, { socketPath });
    assert.equal(sessions.records[0].codexSessionId, "00000000-0000-0000-0000-000000000123");
    assert.equal(sessions.records[0].transcriptPath, join(root, "rollout.jsonl"));
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale launchers are pruned without failing pause", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-supervisor-stale-"));
  const socketPath = join(root, "supervisor.sock");
  const daemon = new SupervisorDaemon({ socketPath, statePath: join(root, "state.json") });
  await daemon.start();
  try {
    daemon.sessions.set("stale", {
      launcherId: "stale",
      product: "agyx",
      launcherPid: 2_147_483_647,
      childPid: 2_147_483_646,
      cwd: "/tmp",
      args: [],
      startedAt: new Date().toISOString(),
      paused: false,
      scope: "unknown",
    });
    const paused = await sendSupervisor({ command: "pause", launcherId: "stale" }, { socketPath });
    assert.equal(paused.ok, true);
    assert.equal(paused.stale, true);
    const sessions = await sendSupervisor({ command: "sessions" }, { socketPath });
    assert.deepEqual(sessions.records, []);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent state persistence does not reuse a temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-supervisor-persist-"));
  const daemon = new SupervisorDaemon({
    socketPath: join(root, "supervisor.sock"),
    statePath: join(root, "state.json"),
  });
  try {
    await Promise.all(Array.from({ length: 20 }, () => daemon.persist()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex remote transport binds identity without scanning session files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-supervisor-codex-identity-"));
  const daemon = new SupervisorDaemon({
    socketPath: join(root, "supervisor.sock"),
    statePath: join(root, "state.json"),
  });
  try {
    await daemon.handle({
      command: "register",
      product: "cdxx",
      launcherId: "codex-file-match",
      launcherPid: process.pid,
      childPid: process.pid,
      cwd: "/tmp/project",
      args: [],
      profileName: "account-a",
      codexHome: join(root, "missing-codex-home"),
      identityMode: "remote",
    });
    await daemon.handle({
      command: "identity",
      launcherId: "codex-file-match",
      sessionId: "session-1",
      cwd: "/tmp/project",
    });
    const session = daemon.sessions.get("codex-file-match");
    assert.equal(session.sessionId, "session-1");
    assert.equal(session.transcriptPath, undefined);
    assert.equal(session.identityMode, "remote");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one Codex failure batch triggers only one failover", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-supervisor-batch-"));
  const transcript = join(root, "session.jsonl");
  const statePath = join(root, "supervisor.json");
  const events = [];
  await writeFile(transcript, [
    JSON.stringify({
      timestamp: "2026-08-04T07:27:30.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 100, resets_at: 1900000000 },
          secondary: { used_percent: 0 },
          rate_limit_reached_type: null,
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-04T07:27:30.211Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        error: {
          message: "You've hit your usage limit; try again at Aug 8th, 2026 8:16 AM.",
          codex_error_info: "usage_limit_exceeded",
        },
      },
    }),
    "",
  ].join("\n"));
  const daemon = new SupervisorDaemon({
    statePath,
    failover: async (session, event) => {
      events.push(event);
      // Reproduce the child-registration race caused by a profile restart.
      session.quotaHandled = false;
    },
  });
  const session = {
    product: "cdxx",
    launcherId: "batch",
    transcriptPath: transcript,
    offset: 0,
    carry: "",
    quotaHandled: false,
  };
  try {
    await daemon.scan(session);
    assert.equal(events.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
