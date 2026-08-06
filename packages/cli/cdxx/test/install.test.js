import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  codexHookCommand,
  configureCodexIntegration,
  shellInit,
} from "../src/install.js";

test("shell integration routes codex through the dispatcher", () => {
  assert.match(shellInit(), /command cdxx dispatch -- "\$@"/);
});

async function withCodexHome(operation) {
  const root = await mkdtemp(join(tmpdir(), "cdxx-install-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try { return await operation(root); }
  finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("supported remote transport is selected without asking for hook consent", async () => {
  await withCodexHome(async (root) => {
    const hookPath = join(root, "hooks.json");
    await writeFile(hookPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: `${codexHookCommand()} codex-hook` }] }],
        Stop: [{ hooks: [{ command: "keep-me" }] }],
      },
    }));
    let prompted = false;
    let saved;
    const result = await configureCodexIntegration("/usr/bin/codex", {
      probeRemote: async () => ({ supported: true }),
      confirmHookInstall: async () => { prompted = true; return true; },
      saveIntegration: async (value) => { saved = value; return value; },
    });
    assert.equal(result.mode, "remote");
    assert.equal(saved.mode, "remote");
    assert.equal(prompted, false);
    const hooks = JSON.parse(await readFile(hookPath, "utf8"));
    assert.deepEqual(Object.keys(hooks.hooks), ["Stop"]);
  });
});

test("unsupported remote transport asks in English before installing hooks", async () => {
  await withCodexHome(async (root) => {
    let promptText = "";
    const result = await configureCodexIntegration("/usr/bin/codex", {
      probeRemote: async () => ({ supported: false, reason: "The installed Codex CLI does not expose --remote." }),
      confirmHookInstall: async (message) => { promptText = message; return true; },
      saveIntegration: async (value) => value,
    });
    assert.equal(result.mode, "hooks");
    assert.match(promptText, /install Codex lifecycle hooks/i);
    assert.match(promptText, /Install the Codex hooks\?/);
    const hooks = JSON.parse(await readFile(join(root, "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.SessionStart.length, 1);
    assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
    assert.equal(hooks.hooks.Stop.length, 1);
  });
});

test("declining hooks disables only the agentx Codex integration", async () => {
  await withCodexHome(async () => {
    const result = await configureCodexIntegration("/usr/bin/codex", {
      probeRemote: async () => ({ supported: false, reason: "Remote transport unavailable." }),
      confirmHookInstall: async () => false,
      saveIntegration: async (value) => value,
    });
    assert.equal(result.mode, "disabled");
    assert.equal(result.reason, "Remote transport unavailable.");
  });
});
