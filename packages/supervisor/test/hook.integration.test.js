import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
