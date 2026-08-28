import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeCodexStatusQuota } from "../src/status_probe.js";

function codexAuth(refreshToken) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: "account", refresh_token: refreshToken },
  });
}

test("isolated status probes merge refreshed Codex auth back to the source profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-status-credential-"));
  const sourceHome = join(root, "source");
  const probeHome = join(root, "probe");
  await mkdir(sourceHome, { recursive: true });
  await mkdir(probeHome, { recursive: true });
  await writeFile(join(sourceHome, "auth.json"), codexAuth("old"));
  await writeFile(join(probeHome, "auth.json"), codexAuth("old"));
  try {
    const result = await probeCodexStatusQuota({
      codexHome: sourceHome,
      probeHome,
      realCodex: "/unused/codex",
      profileName: "profile-a",
      runStatus: async (_realCodex, activeProbeHome) => {
        await writeFile(join(activeProbeHome, "auth.json"), codexAuth("rotated"));
        return { source: "status", limits: {} };
      },
    });

    assert.equal(result.source, "status");
    assert.equal(await readFile(join(sourceHome, "auth.json"), "utf8"), codexAuth("rotated"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
