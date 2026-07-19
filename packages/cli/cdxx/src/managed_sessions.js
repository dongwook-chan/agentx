import { pauseAllSessions, resumeAllSessions, runAuthSwitchTransaction } from "@dong-/agentx-core";
import { execFile } from "node:child_process";
import { chmod, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { connect } from "node:net";
import { join } from "node:path";
import { ensureConfig, runtimeDir } from "./config.js";
import { withAuthSwitchLock } from "./lock.js";
import { supervisorRequest } from "@dong-/agentx-supervisor";

const defaultSessionSocketTimeoutMs = 5000;
const execFileAsync = promisify(execFile);

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

async function send(socketPath, command, payload = {}, options = {}) {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timeoutMs = options.timeoutMs ?? defaultSessionSocketTimeoutMs;
    let input = "";
    let settled = false;
    let timedOut = false;
    let timer;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        socket.destroy();
        settle(reject, new Error(`Timed out waiting for session ${socketPath} to handle '${command}'.`));
      }, timeoutMs);
      timer.unref?.();
    }
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify({ command, ...payload })}\n`));
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("error", (error) => settle(reject, error));
    socket.on("close", () => {
      if (timedOut) return;
      try {
        settle(resolve, JSON.parse(input));
      } catch {
        settle(reject, new Error(`Invalid response from session ${socketPath}`));
      }
    });
  });
}

function parentPidFromStat(content) {
  const endOfCommand = content.lastIndexOf(")");
  if (endOfCommand < 0) return undefined;
  const fields = content.slice(endOfCommand + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

async function parentPid(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  if (stat) return parentPidFromStat(stat);
  const output = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 1000 })
    .then((result) => result.stdout)
    .catch(() => undefined);
  const ppid = Number(output?.trim());
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

export async function currentProcessAncestorPids(pid = process.pid) {
  const ancestors = new Set();
  let current = pid;
  for (let depth = 0; depth < 128 && current > 1; depth += 1) {
    const parent = await parentPid(current);
    if (!parent || ancestors.has(parent)) break;
    ancestors.add(parent);
    current = parent;
  }
  return ancestors;
}

export async function currentManagedSessionRecord(records = undefined) {
  const managed = records ?? await sessionRecords();
  const ancestors = await currentProcessAncestorPids();
  return managed.find((record) => record.childPid && ancestors.has(record.childPid));
}

export async function sessionRecords() {
  try {
    const records = (await supervisorRequest({ command: "sessions" })).records
      .filter((record) => record.product === "cdxx");
    if (records.length) return records;
  } catch {
    // Fall back to legacy per-session records during upgrades.
  }
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

export function sessionControlAdapter(options = {}) {
  return {
    sessionRecords: options.sessionRecords ?? sessionRecords,
    pause: async (record) => {
      if (record.launcherId) {
        const reply = await supervisorRequest({ command: "pause", launcherId: record.launcherId, reason: options.reason });
        return reply.record ?? { ...record, childPid: undefined, paused: true };
      }
      const reply = await send(record.socketPath, "pause", { reason: options.reason }, options);
      if (!reply.ok) throw new Error(reply.error ?? `Failed to pause ${record.id}`);
      return reply.record ?? { ...record, childPid: undefined, paused: true };
    },
    resume: async (record) => {
      if (record.launcherId) {
        await supervisorRequest({ command: "resume", launcherId: record.launcherId, reason: options.reason });
        return;
      }
      const reply = await send(record.socketPath, "resume", { reason: options.reason }, options);
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
  const managed = records.filter((record) => record.launcherId);
  const legacy = records.filter((record) => !record.launcherId);
  if (managed.length) {
    await supervisorRequest({ command: "resume-all", product: "cdxx" });
  }
  if (legacy.length) await resumeAllSessions(sessionControlAdapter(), legacy);
}

export async function resumeManaged() {
  try {
    return (await supervisorRequest({ command: "resume-all", product: "cdxx" })).records ?? [];
  } catch {
    const records = await sessionRecords();
    await resumeAll(records);
    return records;
  }
}

export async function withPausedAuthSwitch(operation, options = {}) {
  const records = await sessionRecords();
  const currentRecord = await currentManagedSessionRecord(records);
  if (currentRecord) {
    throw new Error(
      "Refusing to switch Codex profiles from inside a supervised Codex session. "
      + "Run 'codex x use' or 'codex x next' from a separate shell so the current session is not paused by itself.",
    );
  }
  return await runAuthSwitchTransaction(
    {
      sessionControl: sessionControlAdapter({
        reason: "profile-switch",
        timeoutMs: options.sessionSocketTimeoutMs,
        sessionRecords: async () => records,
      }),
      withLock: withAuthSwitchLock,
    },
    operation,
    options,
  );
}
