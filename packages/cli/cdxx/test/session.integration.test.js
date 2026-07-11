import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
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
    socket.on("close", () => resolve(JSON.parse(input)));
  });
}

async function readSingleSessionRecord(runDir) {
  const entries = (await readdir(runDir)).filter((entry) => entry.endsWith(".json"));
  assert.equal(entries.length, 1);
  return JSON.parse(await readFile(join(runDir, entries[0]), "utf8"));
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
    const resumed = await runCli(["resume"], env);
    assert.equal(resumed.code, 0, resumed.stderr);

    await waitFor(async () => {
      const lines = (await readFile(launches, "utf8")).trim().split("\n");
      return lines.length >= 2;
    });
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
    const record = await readSingleSessionRecord(join(root, "config", "run"));
    const socketPath = record.socketPath;
    const paused = await send(socketPath, { command: "pause", reason: "profile-switch" });
    assert.equal(paused.ok, true);
    const resumed = await send(socketPath, { command: "resume", reason: "profile-switch" });
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
