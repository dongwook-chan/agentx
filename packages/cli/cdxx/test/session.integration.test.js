import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { sendSupervisor } from "@dong-/agentx-supervisor";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

async function runCli(args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: dirname(cliPath),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function send(socketPath, payload) {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let input = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      if (!input) return reject(new Error(`Empty response from ${socketPath}`));
      resolve(JSON.parse(input));
    });
  });
}

async function readSingleSessionRecord(socketPath) {
  const reply = await send(socketPath, { command: "sessions" });
  const records = reply.records.filter((record) => record.product === "cdxx");
  assert.equal(records.length, 1);
  return records[0];
}

test("session resumes even when resume command arrives before pause loop waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-session-integration-"));
  const fakeCodex = join(root, "codex");
  const launches = join(root, "launches.txt");
  await writeFile(fakeCodex, `#!/bin/sh
printf '%s\\n' "$*" >> "$CDXX_TEST_LAUNCHES"
parent_pid=$PPID
sleep_pid=
trap '[ -n "$sleep_pid" ] && kill "$sleep_pid" 2>/dev/null; exit 0' INT TERM
while kill -0 "$parent_pid" 2>/dev/null; do
  sleep 1 &
  sleep_pid=$!
  wait "$sleep_pid"
done
`);
  await chmod(fakeCodex, 0o755);

  const env = {
    ...process.env,
    CDXX_CONFIG_DIR: join(root, "config"),
    CODEX_HOME: join(root, "codex-home"),
    CDXX_REAL_CODEX: fakeCodex,
    CDXX_TEST_LAUNCHES: launches,
    CDXX_DISABLE_STARTUP_STATUS_PROBE: "1",
    AGENTX_SUPERVISOR_SOCKET: join(root, "agentx", "supervisor.sock"),
  };
  const supervisor = spawn(process.execPath, [cliPath, "session", "--"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let supervisorStderr = "";
  supervisor.stderr.setEncoding("utf8");
  supervisor.stderr.on("data", (chunk) => { supervisorStderr += chunk; });

  try {
    await waitFor(async () => {
      try {
        return (await readFile(launches, "utf8")).trim().split("\n").length === 1;
      } catch {
        return false;
      }
    });

    const paused = await runCli(["pause"], env);
    assert.equal(paused.code, 0, paused.stderr);
    assert.match(paused.stdout, /Paused 1/);
    const pausedState = await send(env.AGENTX_SUPERVISOR_SOCKET, { command: "sessions" });
    assert.equal(pausedState.records.length, 1, JSON.stringify(pausedState));
    const resumed = await runCli(["resume"], env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /Resumed 1/);

    try {
      await waitFor(async () => {
        const lines = (await readFile(launches, "utf8")).trim().split("\n");
        return lines.length >= 2;
      });
    } catch (error) {
      const state = await send(env.AGENTX_SUPERVISOR_SOCKET, { command: "sessions" }).catch((sendError) => ({ sendError: String(sendError) }));
      assert.fail(`${error.message}; stderr=${supervisorStderr}; state=${JSON.stringify(state)}`);
    }
    assert.doesNotMatch(supervisorStderr, /Profile switch requested/);
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await new Promise((resolve) => supervisor.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("profile switch restart notice is printed in the supervised Codex terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-session-notice-"));
  const fakeCodex = join(root, "codex");
  const launches = join(root, "launches.txt");
  await writeFile(fakeCodex, `#!/bin/sh
printf '%s\\n' "$*" >> "$CDXX_TEST_LAUNCHES"
parent_pid=$PPID
sleep_pid=
trap '[ -n "$sleep_pid" ] && kill "$sleep_pid" 2>/dev/null; exit 0' INT TERM
while kill -0 "$parent_pid" 2>/dev/null; do
  sleep 1 &
  sleep_pid=$!
  wait "$sleep_pid"
done
`);
  await chmod(fakeCodex, 0o755);

  const env = {
    ...process.env,
    CDXX_CONFIG_DIR: join(root, "config"),
    CODEX_HOME: join(root, "codex-home"),
    CDXX_REAL_CODEX: fakeCodex,
    CDXX_TEST_LAUNCHES: launches,
    CDXX_DISABLE_STARTUP_STATUS_PROBE: "1",
    AGENTX_SUPERVISOR_SOCKET: join(root, "agentx", "supervisor.sock"),
  };
  const supervisor = spawn(process.execPath, [cliPath, "session", "--"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let supervisorStderr = "";
  supervisor.stderr.setEncoding("utf8");
  supervisor.stderr.on("data", (chunk) => { supervisorStderr += chunk; });

  try {
    await waitFor(async () => {
      try {
        return (await readFile(launches, "utf8")).trim().split("\n").length === 1;
      } catch {
        return false;
      }
    });
    const record = await readSingleSessionRecord(env.AGENTX_SUPERVISOR_SOCKET);
    const socketPath = record.socketPath;
    const paused = await sendSupervisor({ command: "pause", launcherId: record.launcherId, reason: "profile-switch" }, { socketPath });
    assert.equal(paused.ok, true);
    await waitFor(async () => {
      const status = await sendSupervisor({ command: "status", launcherId: record.launcherId }, { socketPath }).catch(() => undefined);
      return status?.record && !status.record.childPid;
    });
    const resumed = await sendSupervisor({ command: "resume", launcherId: record.launcherId, reason: "profile-switch" }, { socketPath });
    assert.equal(resumed.ok, true);

    await waitFor(async () =>
      /Profile switch requested/.test(supervisorStderr)
      && /Resuming Codex session after profile switch/.test(supervisorStderr)
    );
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await new Promise((resolve) => supervisor.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
