import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { sendSupervisor } from "@dong-/agentx-supervisor";

async function waitFor(
  predicate: () => Promise<boolean>,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Timed out waiting for condition");
}

function runCLI(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("dist/src/cli.js"), ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function sendSession(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; record?: unknown }> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath);
    let input = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolvePromise(JSON.parse(input)));
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("supervisor pauses and resumes in place with conversation UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "agyx-integration-"));
  const fakeAgy = join(root, "agy");
  const launches = join(root, "launches.txt");
  const conversation = "11111111-1111-1111-1111-111111111111";
  await writeFile(fakeAgy, `#!/bin/sh
log=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--log-file" ]; then log="$arg"; fi
  case "$arg" in --log-file=*) log="\${arg#--log-file=}" ;; esac
  previous="$arg"
done
printf '%s\\n' "$*" >> "$AGYX_TEST_LAUNCHES"
if [ -n "$log" ]; then printf 'Created conversation ${conversation}\\n' >> "$log"; fi
trap 'exit 0' INT TERM
while :; do sleep 1; done
`);
  await chmod(fakeAgy, 0o755);

  const environment = {
    ...process.env,
    AGYX_CONFIG_DIR: join(root, "config"),
    AGYX_REAL_AGY: fakeAgy,
    AGYX_TEST_LAUNCHES: launches,
    AGYX_SKIP_UNMANAGED_AGY_STOP: "1",
    AGENTX_SUPERVISOR_SOCKET: join(root, "agentx", "supervisor.sock"),
  };
  const supervisor = spawn(
    process.execPath,
    [resolve("dist/src/cli.js"), "session", "--", "--model", "test"],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] },
  );
  let supervisorStderr = "";
  supervisor.stderr.setEncoding("utf8");
  supervisor.stderr.on("data", (chunk) => { supervisorStderr += chunk; });

  try {
    await waitFor(async () => {
      try { return (await readFile(launches, "utf8")).trim().split("\n").length === 1; }
      catch { return false; }
    });
    const paused = await runCLI(["pause"], environment);
    assert.equal(paused.code, 0, paused.stderr);
    assert.match(paused.stdout, /Paused 1 supervised session/);

    const sessions = await sendSession(environment.AGENTX_SUPERVISOR_SOCKET, { command: "sessions" }) as { ok: boolean; records: Array<Record<string, unknown>> };
    const record = sessions.records.find((entry) => entry.product === "agyx");
    assert.ok(record);
    assert.equal(record.paused, true);
    assert.equal(record.conversationId, conversation);

    const resumed = await runCLI(["resume"], environment);
    assert.equal(resumed.code, 0, resumed.stderr);
    await waitFor(async () => {
      const lines = (await readFile(launches, "utf8")).trim().split("\n");
      return lines.length >= 2;
    });
    const lines = (await readFile(launches, "utf8")).trim().split("\n");
    assert.match(lines[1]!, /--model test/);
    assert.match(lines[1]!, new RegExp(`--conversation ${conversation}`));
    assert.doesNotMatch(supervisorStderr, /Profile switch requested/);
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await new Promise<void>((resolvePromise) =>
        supervisor.once("exit", () => resolvePromise())
      );
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("profile switch restart notice is printed in the supervised agy terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "agyx-integration-"));
  const fakeAgy = join(root, "agy");
  const launches = join(root, "launches.txt");
  await writeFile(fakeAgy, `#!/bin/sh
printf '%s\\n' "$*" >> "$AGYX_TEST_LAUNCHES"
trap 'exit 0' INT TERM
while :; do sleep 1; done
`);
  await chmod(fakeAgy, 0o755);

  const environment = {
    ...process.env,
    AGYX_CONFIG_DIR: join(root, "config"),
    AGYX_REAL_AGY: fakeAgy,
    AGYX_TEST_LAUNCHES: launches,
    AGYX_SKIP_UNMANAGED_AGY_STOP: "1",
    AGENTX_SUPERVISOR_SOCKET: join(root, "agentx", "supervisor.sock"),
  };
  const supervisor = spawn(
    process.execPath,
    [resolve("dist/src/cli.js"), "session", "--"],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] },
  );
  let supervisorStderr = "";
  supervisor.stderr.setEncoding("utf8");
  supervisor.stderr.on("data", (chunk) => { supervisorStderr += chunk; });

  try {
    await waitFor(async () => {
      try { return (await readFile(launches, "utf8")).trim().split("\n").length === 1; }
      catch { return false; }
    });
    const sessions = await sendSession(environment.AGENTX_SUPERVISOR_SOCKET, { command: "sessions" }) as { ok: boolean; records: Array<Record<string, unknown>> };
    const record = sessions.records.find((entry) => entry.product === "agyx");
    assert.ok(record);
    const paused = await sendSupervisor({ command: "pause", launcherId: record.launcherId, reason: "profile-switch" }, { socketPath: environment.AGENTX_SUPERVISOR_SOCKET });
    assert.equal(paused.ok, true);
    await waitFor(async () => {
      const status = await sendSupervisor({ command: "status", launcherId: record.launcherId }, { socketPath: environment.AGENTX_SUPERVISOR_SOCKET });
      return Boolean(status.record && !(status.record as { childPid?: number }).childPid);
    });
    const resumed = await sendSupervisor({ command: "resume", launcherId: record.launcherId, reason: "profile-switch" }, { socketPath: environment.AGENTX_SUPERVISOR_SOCKET });
    assert.equal(resumed.ok, true);

    await waitFor(async () =>
      /Profile switch requested/.test(supervisorStderr)
      && /Resuming agy session after profile switch/.test(supervisorStderr)
    );
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await new Promise<void>((resolvePromise) =>
        supervisor.once("exit", () => resolvePromise())
      );
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("auto switch does not pause sessions before quota policy allows switching", async () => {
  const root = await mkdtemp(join(tmpdir(), "agyx-integration-"));
  const config = join(root, "config");
  const runtime = join(config, "run");
  const now = "2026-07-05T00:00:00.000Z";
  await mkdir(runtime, { recursive: true });
  await writeFile(join(config, "state.json"), `${JSON.stringify({
    version: 1,
    activeProfile: "a",
    settings: { autoSwitchMode: "all-providers" },
    profiles: [
      {
        name: "a",
        email: "a@example.com",
        createdAt: now,
        updatedAt: now,
        quotaScopes: {
          claude: {
            status: "exhausted",
            resetAt: "2026-07-06T00:00:00.000Z",
            reason: "RESOURCE_EXHAUSTED",
          },
        },
      },
      {
        name: "b",
        email: "b@example.com",
        createdAt: now,
        updatedAt: now,
      },
    ],
  }, null, 2)}\n`);
  await writeFile(join(runtime, "dummy.json"), `${JSON.stringify({
    id: "dummy",
    pid: process.pid,
    cwd: root,
    args: [],
    socketPath: join(runtime, "missing.sock"),
    logPath: join(config, "logs", "dummy.log"),
    paused: false,
    restartable: true,
    startedAt: now,
  }, null, 2)}\n`);

  try {
    const result = await runCLI(["_auto-next", "claude"], {
      ...process.env,
      AGYX_CONFIG_DIR: config,
      AGYX_SKIP_UNMANAGED_AGY_STOP: "1",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { kind: "none" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage probe timeout cleans up the probed agy process", async () => {
  const root = await mkdtemp(join(tmpdir(), "agyx-integration-"));
  const config = join(root, "config");
  const fakeAgy = join(root, "agy");
  const pidFile = join(root, "agy.pid");
  const now = "2026-07-05T00:00:00.000Z";
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "state.json"), `${JSON.stringify({
    version: 1,
    activeProfile: "p",
    profiles: [
      {
        name: "p",
        email: "p@example.com",
        createdAt: now,
        updatedAt: now,
      },
    ],
  }, null, 2)}\n`);
  await writeFile(fakeAgy, `#!/bin/sh
printf '%s\\n' "$$" > "$AGYX_TEST_PROBE_PID"
trap 'exit 0' HUP INT TERM
while :; do sleep 1; done
`);
  await chmod(fakeAgy, 0o755);

  let pid: number | undefined;
  try {
    const result = await runCLI([
      "_usage-probe",
      JSON.stringify({
        profileName: "p",
        realAgy: fakeAgy,
        cwd: root,
        timeoutMs: 500,
      }),
    ], {
      ...process.env,
      AGYX_CONFIG_DIR: config,
      AGYX_TEST_PROBE_PID: pidFile,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(pid));
    await waitFor(async () => !processAlive(pid!), 5000);
  } finally {
    if (pid && processAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); }
      catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});
