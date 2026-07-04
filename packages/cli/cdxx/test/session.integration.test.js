import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("session resumes even when resume command arrives before pause loop waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-session-integration-"));
  const fakeCodex = join(root, "codex");
  const launches = join(root, "launches.txt");
  await writeFile(fakeCodex, `#!/bin/sh
printf '%s\\n' "$*" >> "$CDXX_TEST_LAUNCHES"
trap 'exit 0' INT TERM
while :; do sleep 1; done
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
    stdio: "ignore",
  });

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
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await new Promise((resolve) => supervisor.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
