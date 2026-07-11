import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "cdxx-failover-policy-"));
process.env.CODEX_HOME = join(root, "codex-home");
process.env.CDXX_CONFIG_DIR = join(root, "config");

const auth = await import("../src/auth.js");
const config = await import("../src/config.js");
const sessions = await import("../src/managed_sessions.js");
const { decideCodexFailover } = await import("../src/failover_policy.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function codexAuth(accountId) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      refresh_token: `refresh-${accountId}`,
    },
  });
}

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

async function writeProfile(name, accountId = name) {
  await mkdir(join(process.env.CDXX_CONFIG_DIR, "profiles", name), { recursive: true });
  await writeFile(auth.profileAuthPath(name), codexAuth(accountId), { mode: 0o600 });
}

async function resetState() {
  await rm(root, { recursive: true, force: true });
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  await mkdir(join(process.env.CDXX_CONFIG_DIR, "run"), { recursive: true });
  await writeProfile("a");
  await writeProfile("b");
  await writeFile(auth.activeAuthPath, codexAuth("a"), { mode: 0o600 });
  await writeFile(config.statePath, `${JSON.stringify({
    version: 1,
    activeProfile: "a",
    profiles: [
      { name: "a", accountId: "a", quotaStatus: "available" },
      { name: "b", accountId: "b", quotaStatus: "available" },
    ],
    settings: { autoswitch: true, yolo: true },
    sessions: {},
  })}\n`);
}

test("quota failover switches under the shared paused-session transaction", async () => {
  await resetState();
  const socketPath = join(process.env.CDXX_CONFIG_DIR, "run", "supervised.sock");
  const record = {
    id: "supervised",
    pid: process.pid,
    childPid: 12345,
    cwd: root,
    args: ["resume", "session-a"],
    codexSessionId: "session-a",
    socketPath,
    paused: false,
    restartable: true,
    startedAt: new Date().toISOString(),
  };
  await sessions.writeRuntimeRecord(sessions.runtimeRecordPath(record.id), record);

  const requests = [];
  const server = await listen(socketPath, (request) => {
    requests.push(request);
    if (request.command === "pause") {
      return { ok: true, record: { ...record, childPid: undefined, paused: true } };
    }
    if (request.command === "resume") return { ok: true };
    return { ok: false, error: "unexpected" };
  });

  try {
    const action = await decideCodexFailover({
      profileName: "a",
      sessionId: "session-a",
      primary: 100,
      secondary: 10,
      resetAt: "2026-07-11T02:32:55.000Z",
      timestamp: "2026-07-11T00:54:34.245Z",
      planType: "plus",
    });

    assert.equal(action.kind, "sessions_restarted");
    assert.equal(action.profile, "b");
    assert.deepEqual(
      requests.map((request) => [request.command, request.reason]),
      [["pause", "profile-switch"], ["resume", "profile-switch"]],
    );
    assert.equal(await readFile(auth.activeAuthPath, "utf8"), codexAuth("b"));
    const state = await config.loadState();
    assert.equal(state.activeProfile, "b");
    assert.equal(state.profiles.find((profile) => profile.name === "a")?.quotaStatus, "exhausted");
  } finally {
    server.close();
  }
});
