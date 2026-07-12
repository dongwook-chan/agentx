import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "cdxx-managed-sessions-"));
process.env.CDXX_CONFIG_DIR = join(root, "config");

const sessions = await import("../src/managed_sessions.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listen(path, handler) {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("end", () => {
      const request = JSON.parse(input);
      socket.end(`${JSON.stringify(handler(request))}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

test("pauseAll and resumeAll use the managed session socket protocol", async () => {
  const socketPath = join(process.env.CDXX_CONFIG_DIR, "run", "fake.sock");
  const recordPath = sessions.runtimeRecordPath("fake");
  const commands = [];
  const record = {
    id: "fake",
    pid: process.pid,
    childPid: 12345,
    cwd: root,
    args: [],
    socketPath,
    paused: false,
    restartable: true,
    startedAt: new Date().toISOString(),
  };
  await sessions.writeRuntimeRecord(recordPath, record);
  const server = await listen(socketPath, (request) => {
    commands.push(request.command);
    if (request.command === "pause") {
      return { ok: true, record: { ...record, childPid: undefined, paused: true } };
    }
    if (request.command === "resume") return { ok: true };
    return { ok: false, error: "unexpected" };
  });
  try {
    assert.equal((await sessions.sessionRecords()).length, 1);
    const paused = await sessions.pauseAll();
    assert.equal(paused.length, 1);
    assert.equal(paused[0].paused, true);
    assert.equal(paused[0].childPid, undefined);
    await sessions.resumeAll(paused);
    assert.deepEqual(commands, ["pause", "resume"]);
  } finally {
    server.close();
    await sessions.cleanupRuntimeFile(socketPath);
  }
});

test("profile-switch session adapter sends restart reason", async () => {
  const socketPath = join(process.env.CDXX_CONFIG_DIR, "run", "reason.sock");
  const recordPath = sessions.runtimeRecordPath("reason");
  const requests = [];
  const record = {
    id: "reason",
    pid: process.pid,
    childPid: 12346,
    cwd: root,
    args: [],
    socketPath,
    paused: false,
    restartable: true,
    startedAt: new Date().toISOString(),
  };
  await sessions.writeRuntimeRecord(recordPath, record);
  const server = await listen(socketPath, (request) => {
    requests.push(request);
    if (request.command === "pause") return { ok: true, record: { ...record, paused: true } };
    if (request.command === "resume") return { ok: true };
    return { ok: false, error: "unexpected" };
  });
  try {
    const adapter = sessions.sessionControlAdapter({ reason: "profile-switch" });
    const paused = await adapter.pause(record);
    await adapter.resume(paused);
    assert.deepEqual(requests.map((request) => request.reason), ["profile-switch", "profile-switch"]);
  } finally {
    server.close();
    await sessions.cleanupRuntimeFile(socketPath);
  }
});

test("session socket calls time out instead of hanging indefinitely", async () => {
  const socketPath = join(process.env.CDXX_CONFIG_DIR, "run", "timeout.sock");
  const record = {
    id: "timeout",
    pid: process.pid,
    childPid: 12347,
    cwd: root,
    args: [],
    socketPath,
    paused: false,
    restartable: true,
    startedAt: new Date().toISOString(),
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", () => {});
    socket.on("end", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const adapter = sessions.sessionControlAdapter({ timeoutMs: 20 });
    await assert.rejects(
      async () => await adapter.pause(record),
      /Timed out waiting for session .*timeout\.sock.*pause/,
    );
  } finally {
    server.close();
    await sessions.cleanupRuntimeFile(socketPath);
  }
});

test("profile switches are refused from inside the current managed Codex session", async () => {
  const ancestors = await sessions.currentProcessAncestorPids();
  const childPid = [...ancestors][0];
  assert.ok(childPid, "test process should have a parent pid");
  const recordPath = sessions.runtimeRecordPath("self");
  await sessions.writeRuntimeRecord(recordPath, {
    id: "self",
    pid: process.pid,
    childPid,
    cwd: root,
    args: [],
    socketPath: join(process.env.CDXX_CONFIG_DIR, "run", "self.sock"),
    paused: false,
    restartable: true,
    startedAt: new Date().toISOString(),
  });
  try {
    await assert.rejects(
      async () => await sessions.withPausedAuthSwitch(async () => "should-not-run"),
      /Refusing to switch Codex profiles from inside a supervised Codex session/,
    );
  } finally {
    await sessions.cleanupRuntimeFile(recordPath);
  }
});
