import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir, ensureConfig } from "./config.js";
import { wait } from "./quota_tail.js";

const lockDir = join(configDir, "auth-switch.lock");
let lockDepth = 0;

async function lockOwnerIsDead() {
  const owner = await readFile(join(lockDir, "owner"), "utf8").catch(() => undefined);
  const pid = Number(owner?.split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

export async function withAuthSwitchLock(fn, options = {}) {
  if (lockDepth > 0) return await fn();
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const staleMs = options.staleMs ?? 30 * 60_000;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (Date.now() <= deadline) {
    await ensureConfig();
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(join(lockDir, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await stat(lockDir).catch(() => undefined);
      if (await lockOwnerIsDead()) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await wait(100);
    }
  }

  if (!acquired) throw new Error("Timed out waiting for cdxx auth switch lock.");
  lockDepth += 1;
  try {
    return await fn();
  } finally {
    lockDepth -= 1;
    if (lockDepth === 0) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
