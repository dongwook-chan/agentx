import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SupervisorDaemon } from "../src/daemon.js";
import { sendSupervisor } from "../src/client.js";

async function waitForRuntimeRemoval(paths) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const existing = await Promise.all(paths.map(async (path) =>
      await stat(path).then(() => true).catch(() => false)
    ));
    if (existing.every((exists) => !exists)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Supervisor runtime files were not removed: ${paths.join(", ")}`);
}

test("shutdown closes an idle supervisor and removes its runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-supervisor-lifecycle-"));
  const socketPath = join(root, "supervisor.sock");
  const statePath = join(root, "supervisor.json");
  const daemon = new SupervisorDaemon({
    socketPath,
    statePath,
    enableGlobalCodexWatch: false,
  });
  await daemon.start();

  try {
    const reply = await sendSupervisor({ command: "shutdown" }, { socketPath });
    assert.equal(reply.ok, true);
    await waitForRuntimeRemoval([socketPath, statePath]);
  } finally {
    await daemon.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
