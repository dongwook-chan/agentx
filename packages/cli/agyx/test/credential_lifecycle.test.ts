import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "agyx-credential-lifecycle-"));
process.env.AGYX_CONFIG_DIR = join(root, "config");
process.env.AGYX_ACTIVE_CREDENTIAL_PATH = join(root, "active", "antigravity-oauth-token");

const { activateProfile } = await import("../src/coordinator.js");
const { keychain } = await import("../src/keychain.js");
const { loadState, saveState } = await import("../src/config.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function agyCredential(account: string, access: string): Buffer {
  return Buffer.from(JSON.stringify({
    token: {
      access_token: access,
      refresh_token: `refresh-${account}`,
      expiry: "2030-01-01T00:00:00Z",
    },
  }));
}

test("activateProfile persists refreshed active Agy auth before replacing the active slot", async () => {
  const oldSaved = agyCredential("old", "old-stale");
  const oldRefreshed = agyCredential("old", "old-refreshed");
  const next = agyCredential("next", "next-access");
  await mkdir(join(root, "active"), { recursive: true });
  await writeFile(process.env.AGYX_ACTIVE_CREDENTIAL_PATH!, oldRefreshed, { mode: 0o600 });
  await keychain.writeProfile("old", oldSaved);
  await keychain.writeProfile("next", next);
  const now = new Date().toISOString();
  await saveState({
    version: 1,
    activeProfile: "old",
    profiles: [
      { name: "old", createdAt: now, updatedAt: now, quotaStatus: "available" },
      { name: "next", createdAt: now, updatedAt: now, quotaStatus: "available" },
    ],
  });

  await activateProfile("next");

  assert.deepEqual(await keychain.readProfile("old"), oldRefreshed);
  assert.deepEqual(await readFile(process.env.AGYX_ACTIVE_CREDENTIAL_PATH!), next);
  assert.equal((await loadState()).activeProfile, "next");
});
