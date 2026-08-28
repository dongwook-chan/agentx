import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendSupervisor } from "@dong-/agentx-supervisor";

const root = await mkdtemp(join(tmpdir(), "cdxx-failover-policy-"));
process.env.CODEX_HOME = join(root, "codex-home");
process.env.CDXX_CONFIG_DIR = join(root, "config");
process.env.AGENTX_SUPERVISOR_SOCKET = join(root, "agentx-supervisor.sock");

const auth = await import("../src/auth.js");
const config = await import("../src/config.js");
const sessions = await import("../src/managed_sessions.js");
const { decideCodexFailover, quotaSummaryFromSupervisorPayload } = await import("../src/failover_policy.js");

after(async () => {
  await shutdownTestSupervisor();
  await rm(root, { recursive: true, force: true });
});

async function shutdownTestSupervisor() {
  await sendSupervisor(
    { command: "shutdown" },
    { socketPath: process.env.AGENTX_SUPERVISOR_SOCKET, timeoutMs: 100 },
  ).catch(() => undefined);
}

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
  await shutdownTestSupervisor();
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
    if (request.command === "notice") return { ok: true };
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
      requests.map((request) => [request.command, request.reason, request.message]),
      [
        ["pause", "profile-switch", undefined],
        ["notice", undefined, "\r\n\r\n\r\n[cdxx] Quota detected; switching profiles..."],
        ["resume", "profile-switch", undefined],
      ],
    );
    assert.equal(await readFile(auth.activeAuthPath, "utf8"), codexAuth("b"));
    const state = await config.loadState();
    assert.equal(state.activeProfile, "b");
    assert.equal(state.profiles.find((profile) => profile.name === "a")?.quotaStatus, "exhausted");
    const events = (await readFile(config.eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const productEvents = events.filter((event) => event.emitter !== "agentx-supervisor");
    assert.deepEqual(
      productEvents.map((event) => event.event),
      ["quota.detected", "profile.selected", "switch.completed"],
    );
    assert.equal(productEvents[0].product, "cdxx");
    assert.equal(productEvents[0].profile, "a");
    assert.equal(productEvents[1].fromProfile, "a");
    assert.equal(productEvents[1].toProfile, "b");
    assert.equal(productEvents[2].actionKind, "sessions_restarted");
  } finally {
    server.close();
  }
});

test("quota failover does not await background status refresh when reset metadata is missing", async () => {
  await resetState();
  let scheduledProfile;
  const never = new Promise(() => undefined);

  const liveSummary = quotaSummaryFromSupervisorPayload({
    reason: "You've hit your usage limit.",
  });
  assert.equal(liveSummary.current.primary, undefined);
  assert.equal(liveSummary.current.secondary, undefined);

  const action = await Promise.race([
    decideCodexFailover({
      profileName: "a",
      sessionId: "session-a",
      reachedType: "usage_limit_exceeded",
      reason: "You've hit your usage limit.",
      timestamp: "2026-08-07T00:00:00.000Z",
    }, {
      scheduleStatusRefresh: (name) => {
        scheduledProfile = name;
        return never;
      },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("failover waited for status refresh")), 1000)),
  ]);

  assert.equal(action.kind, "sessions_restarted");
  assert.equal(action.profile, "b");
  assert.equal(scheduledProfile, "a");
  assert.equal(await readFile(auth.activeAuthPath, "utf8"), codexAuth("b"));
  const state = await config.loadState();
  assert.equal(state.activeProfile, "b");
  const exhausted = state.profiles.find((profile) => profile.name === "a");
  assert.equal(exhausted?.quotaStatus, "exhausted");
  assert.equal(exhausted?.quotaScopes?.unknown?.status, "exhausted");
});

test("a stale concurrent quota event does not switch past the replacement profile", async () => {
  await resetState();
  const first = await decideCodexFailover({
    profileName: "a",
    sessionId: "session-a",
    reachedType: "usage_limit_exceeded",
    reason: "usage limit reached",
    timestamp: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(first.kind, "sessions_restarted");
  assert.equal(first.profile, "b");

  const stale = await decideCodexFailover({
    profileName: "a",
    sessionId: "session-b",
    reachedType: "usage_limit_exceeded",
    reason: "usage limit reached",
    timestamp: "2026-08-13T00:00:00.100Z",
  });
  assert.equal(stale.kind, "none");
  assert.equal(stale.reason, "profile_already_switched");
  assert.equal(stale.profile, "b");
  assert.equal((await config.loadState()).activeProfile, "b");
});

test("quota failover releases a stale resetless candidate before selection", async () => {
  await resetState();
  const state = await config.loadState();
  const candidate = state.profiles.find((profile) => profile.name === "b");
  candidate.quotaStatus = "exhausted";
  candidate.lastQuotaReason = "copied historical usage-limit event";
  candidate.quotaScopes = {
    unknown: {
      status: "exhausted",
      reason: candidate.lastQuotaReason,
      checkedAt: "2026-08-13T00:00:00.000Z",
    },
  };
  await config.saveState(state);

  const action = await decideCodexFailover({
    profileName: "a",
    sessionId: "session-a",
    reachedType: "usage_limit_exceeded",
    reason: "usage limit reached",
    timestamp: "2026-08-17T00:00:00.000Z",
  });

  assert.equal(action.kind, "sessions_restarted");
  assert.equal(action.profile, "b");
  const updated = await config.loadState();
  assert.equal(updated.profiles.find((profile) => profile.name === "b")?.quotaStatus, "available");
});
