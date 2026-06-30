import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "cdxx-login-guard-"));
process.env.CODEX_HOME = join(root, "codex-home");
process.env.CDXX_CONFIG_DIR = join(root, "config");

const auth = await import("../src/auth.js");
const config = await import("../src/config.js");

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

async function resetState(activeProfile = "old") {
  await rm(root, { recursive: true, force: true });
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  await mkdir(process.env.CDXX_CONFIG_DIR, { recursive: true });
  await writeFile(auth.activeAuthPath, codexAuth("old"), { mode: 0o600 });
  await writeFile(config.statePath, `${JSON.stringify({
    version: 1,
    activeProfile,
    profiles: activeProfile
      ? [{ name: activeProfile, accountId: "old", quotaStatus: "available" }]
      : [],
    settings: { autoswitch: false, yolo: true },
    sessions: {},
  })}\n`);
}

test("guardedLoginProfile restores previous Codex auth when login clears auth without replacement", async () => {
  await resetState("old");
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const code = await auth.guardedLoginProfile("new", async () => {
      await rm(auth.activeAuthPath, { force: true });
      return 0;
    });

    assert.equal(code, 1);
    assert.equal(await readFile(auth.activeAuthPath, "utf8"), codexAuth("old"));
    const state = await config.loadState();
    assert.equal(state.activeProfile, "old");
    assert.equal(state.profiles.some((profile) => profile.name === "new"), false);
    assert.match(errors.join("\n"), /Restored previous active profile 'old'/);
  } finally {
    console.error = originalError;
  }
});

test("guardedLoginProfile saves valid Codex auth produced by login", async () => {
  await resetState("old");
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    const code = await auth.guardedLoginProfile("new", async () => {
      await writeFile(auth.activeAuthPath, codexAuth("new"), { mode: 0o600 });
      return 0;
    });

    assert.equal(code, 0);
    assert.equal(await readFile(auth.activeAuthPath, "utf8"), codexAuth("new"));
    assert.equal(await readFile(auth.profileAuthPath("new"), "utf8"), codexAuth("new"));
    const state = await config.loadState();
    assert.equal(state.activeProfile, "new");
    assert.equal(state.profiles.find((profile) => profile.name === "new")?.accountId, "new");
  } finally {
    console.log = originalLog;
  }
});

test("guardedLoginProfile can capture auth from an isolated login home", async () => {
  await resetState("old");
  const isolatedHome = join(root, "isolated-login");
  await mkdir(isolatedHome, { recursive: true });
  const isolatedAuthPath = join(isolatedHome, "auth.json");
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    const code = await auth.guardedLoginProfile("isolated", async () => {
      assert.equal(await readFile(auth.activeAuthPath, "utf8"), codexAuth("old"));
      await writeFile(isolatedAuthPath, codexAuth("isolated"), { mode: 0o600 });
      return 0;
    }, { candidateAuthPath: isolatedAuthPath });

    assert.equal(code, 0);
    assert.equal(await readFile(auth.activeAuthPath, "utf8"), codexAuth("isolated"));
    assert.equal(await readFile(auth.profileAuthPath("isolated"), "utf8"), codexAuth("isolated"));
  } finally {
    console.log = originalLog;
  }
});

test("guardedLoginProfile leaves active auth intact when isolated login is cancelled", async () => {
  await resetState("old");
  const isolatedAuthPath = join(root, "missing-login", "auth.json");
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const code = await auth.guardedLoginProfile("new", async () => 130, {
      candidateAuthPath: isolatedAuthPath,
    });

    assert.equal(code, 130);
    assert.equal(await readFile(auth.activeAuthPath, "utf8"), codexAuth("old"));
    assert.match(errors.join("\n"), /Restored previous active profile 'old'/);
  } finally {
    console.error = originalError;
  }
});

test("isValidCodexAuth rejects missing credentials", () => {
  assert.equal(auth.isValidCodexAuth(codexAuth("ok")), true);
  assert.equal(auth.isValidCodexAuth(JSON.stringify({ auth_mode: "chatgpt", tokens: {} })), false);
  assert.equal(auth.isValidCodexAuth("{"), false);
});
