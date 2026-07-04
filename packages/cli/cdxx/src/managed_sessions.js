import { pauseAllSessions, resumeAllSessions } from "@dong-/agentx-core";
import { chmod, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { ensureConfig, runtimeDir } from "./config.js";

export function runtimeRecordPath(id) {
  return join(runtimeDir, `${id}.json`);
}

export function runtimeSocketPath(pid = process.pid) {
  return join(runtimeDir, `${pid}.sock`);
}

export async function cleanupRuntimeFile(path) {
  await rm(path, { force: true }).catch(() => undefined);
}

function parseJsonPrefix(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    for (let index = 0; index < content.length; index += 1) {
      const character = content[index];
      if (!started) {
        if (/\s/.test(character)) continue;
        if (character !== "{") throw error;
        started = true;
        depth = 1;
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = inString;
        continue;
      }
      if (character === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth === 0) return JSON.parse(content.slice(0, index + 1));
    }
    throw error;
  }
}

export async function writeRuntimeRecord(path, record) {
  await ensureConfig();
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function send(socketPath, command) {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let input = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify({ command })}\n`));
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse(input));
      } catch {
        reject(new Error(`Invalid response from session ${socketPath}`));
      }
    });
  });
}

export async function sessionRecords() {
  await ensureConfig();
  const entries = await readdir(runtimeDir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const records = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const path = join(runtimeDir, entry);
    try {
      const record = parseJsonPrefix(await readFile(path, "utf8"));
      process.kill(record.pid, 0);
      await writeRuntimeRecord(path, record);
      records.push(record);
    } catch {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  return records;
}

export function sessionControlAdapter() {
  return {
    sessionRecords,
    pause: async (record) => {
      const reply = await send(record.socketPath, "pause");
      if (!reply.ok) throw new Error(reply.error ?? `Failed to pause ${record.id}`);
      return reply.record ?? { ...record, childPid: undefined, paused: true };
    },
    resume: async (record) => {
      const reply = await send(record.socketPath, "resume");
      if (!reply.ok) throw new Error(reply.error ?? `Failed to resume ${record.id}`);
    },
    onResumeError: (record, error) => {
      console.error(`cdxx: failed to resume session ${record.id}: ${error?.message ?? error}`);
    },
  };
}

export async function pauseAll() {
  return await pauseAllSessions(sessionControlAdapter());
}

export async function resumeAll(records) {
  await resumeAllSessions(sessionControlAdapter(), records);
}
