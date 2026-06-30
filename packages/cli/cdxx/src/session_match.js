import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexHome } from "./config.js";

export const defaultSessionsDir = join(codexHome, "sessions");

async function walkJsonl(dir, out = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

async function readFirstJsonLine(path) {
  const content = await readFile(path, "utf8").catch(() => "");
  const line = content.split(/\r?\n/, 1)[0];
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export async function snapshotSessionFiles(sessionsDir = defaultSessionsDir) {
  const files = await walkJsonl(sessionsDir);
  const snapshot = new Map();
  for (const file of files) {
    const info = await stat(file).catch(() => undefined);
    if (info) snapshot.set(file, { mtimeMs: info.mtimeMs, size: info.size });
  }
  return snapshot;
}

export async function readSessionMeta(file) {
  const first = await readFirstJsonLine(file);
  if (first?.type !== "session_meta") return undefined;
  const payload = first.payload ?? {};
  const sessionId = payload.session_id ?? payload.id;
  const timestamp = payload.timestamp ?? first.timestamp;
  const timestampMs = Date.parse(timestamp);
  const info = await stat(file).catch(() => undefined);
  return {
    file,
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
    timestamp,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
    recordTimestamp: first.timestamp,
    recordTimestampMs: Number.isFinite(Date.parse(first.timestamp)) ? Date.parse(first.timestamp) : undefined,
    cwd: payload.cwd,
    originator: payload.originator,
    source: payload.source,
    threadSource: payload.thread_source,
    cliVersion: payload.cli_version,
    mtimeMs: info?.mtimeMs,
  };
}

function candidateScore(meta, startMs) {
  const timestampDistance = meta.timestampMs === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.abs(meta.timestampMs - startMs);
  const modifiedDistance = meta.mtimeMs === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.abs(meta.mtimeMs - startMs);
  return timestampDistance * 10 + modifiedDistance;
}

function snapshotMtime(value) {
  return typeof value === "number" ? value : value?.mtimeMs;
}

function snapshotSize(value) {
  return typeof value === "number" ? undefined : value?.size;
}

export async function findMatchingSession({
  sessionsDir = defaultSessionsDir,
  before = new Map(),
  cwd = process.cwd(),
  startMs,
  toleranceBeforeMs = 5000,
  includeExistingModified = true,
} = {}) {
  if (!startMs) throw new Error("findMatchingSession requires startMs.");
  const files = await walkJsonl(sessionsDir);
  const candidates = [];
  for (const file of files) {
    const info = await stat(file).catch(() => undefined);
    if (!info) continue;
    const previous = before.get(file);
    const previousMtime = snapshotMtime(previous);
    const isNew = !before.has(file);
    const isModified = includeExistingModified && previousMtime !== undefined && info.mtimeMs > previousMtime + 1;
    if (!isNew && !isModified) continue;

    const meta = await readSessionMeta(file);
    if (!meta) continue;
    if (meta.cwd !== cwd) continue;
    if (meta.originator && meta.originator !== "codex-tui") continue;
    const eventMs = meta.timestampMs ?? meta.recordTimestampMs ?? info.mtimeMs;
    if (eventMs < startMs - toleranceBeforeMs) continue;
    candidates.push({
      ...meta,
      isNew,
      isModified,
      previousSize: isNew ? 0 : snapshotSize(previous),
      score: candidateScore({ ...meta, mtimeMs: info.mtimeMs }, startMs),
    });
  }
  candidates.sort((left, right) => left.score - right.score);
  return candidates[0];
}

export async function waitForMatchingSession(options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline && !options.signal?.aborted) {
    last = await findMatchingSession(options);
    if (last?.sessionId) return last;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }
    });
  }
  return last;
}
