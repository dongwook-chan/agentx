import { readdirSync, statSync, watch } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  agentCliManifests,
  SessionProfileOwnershipRegistry,
} from "@dong-/agentx-core";
import { parseCodexQuotaLine } from "./quota.js";

const codexSessionIdPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function sessionIdFromPath(file) {
  return basename(file).match(codexSessionIdPattern)?.[0];
}

function walkSessionTree(root) {
  const files = [];
  const directories = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    directories.push(directory);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { entries = []; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return { files, directories };
}

function existingDirectory(path) {
  try { return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true; }
  catch { return false; }
}

function utcDateParts(nowMs) {
  const date = new Date(nowMs);
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ];
}

function recentSessionTree(root, nowMs) {
  const files = new Set();
  const directories = new Set([root]);
  let rootEntries;
  try { rootEntries = readdirSync(root, { withFileTypes: true }); }
  catch { rootEntries = []; }
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(join(root, entry.name));
  }

  for (const deltaMs of [0, -24 * 60 * 60 * 1000]) {
    const [year, month, day] = utcDateParts(nowMs + deltaMs);
    const ancestors = [join(root, year), join(root, year, month), join(root, year, month, day)];
    for (const directory of ancestors) {
      if (existingDirectory(directory)) directories.add(directory);
    }
    const dateDirectory = ancestors.at(-1);
    if (!existingDirectory(dateDirectory)) continue;
    const tree = walkSessionTree(dateDirectory);
    for (const directory of tree.directories) directories.add(directory);
    for (const file of tree.files) files.add(file);
  }
  return { files: [...files], directories: [...directories] };
}

function parseLifecycle(line) {
  if (!line.includes("session_meta") && !line.includes("task_started")) return undefined;
  try {
    const event = JSON.parse(line);
    if (event.type === "session_meta") {
      return {
        sessionId: event.payload?.id ?? event.payload?.session_id,
        parentSessionId:
          event.payload?.source?.subagent?.thread_spawn?.parent_thread_id
          ?? event.payload?.source?.subagent?.parent_thread_id
          ?? event.payload?.parent_session_id,
      };
    }
    if (event.type === "event_msg" && event.payload?.type === "task_started") {
      return { turnStarted: true };
    }
  } catch {
    // Partial or malformed lifecycle records do not affect quota detection.
  }
  return undefined;
}

/**
 * Watches every Codex JSONL transcript while reading only appended bytes.
 * Existing files are indexed at EOF so historical quota records never trigger
 * failover when the supervisor starts.
 */
export class CodexGlobalSessionWatcher {
  constructor(options) {
    this.sessionsDir = resolve(options.sessionsDir);
    this.getActiveProfile = options.getActiveProfile;
    this.isManagedSession = options.isManagedSession ?? (() => false);
    this.onQuota = options.onQuota;
    this.onError = options.onError ?? (() => undefined);
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.watchFactory = options.watchFactory ?? watch;
    this.now = options.now ?? Date.now;
    this.observationPolicy = options.observationPolicy
      ?? agentCliManifests.codex.quotaFailover.unmanagedTranscriptObservation;
    this.reconcileIntervalMs = options.reconcileIntervalMs
      ?? this.observationPolicy.maxReconcileDelayMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs
      ?? this.observationPolicy.heartbeatIntervalMs;
    this.ownership = options.ownership ?? new SessionProfileOwnershipRegistry();
    this.tracks = new Map();
    this.dirty = new Set();
    this.watchers = new Map();
    this.discovering = new Set();
    this.recovering = false;
    this.closed = false;
    this.watchSequence = 0;
    this.watchSignals = new Map();
    this.lastWatchEventAtMs = undefined;
    this.lastWatchEventPath = undefined;
    this.lastReconcileAtMs = undefined;
    this.lastHeartbeatAtMs = undefined;
    this.lastFileScanAtMs = undefined;
    this.lastScannedFile = undefined;
    this.startedAtMs = undefined;
    this.reconcileCount = 0;
    this.lastReconcileDurationMs = undefined;
    this.lastReconciledFileCount = 0;
    this.lastRecentDirectoryCount = 0;
    this.recoveryCounts = Object.fromEntries(
      this.observationPolicy.recoveryDiagnoses.map((diagnosis) => [diagnosis, 0]),
    );
    this.diagnosticFailureCount = 0;
  }

  async start() {
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    await this.snapshotExisting();
    const nowMs = this.now();
    this.startedAtMs = nowMs;
    this.lastReconcileAtMs = nowMs;
    this.lastHeartbeatAtMs = nowMs;
    await this.emitDiagnostic({
      event: "supervisor.global_watch.started",
      ...this.diagnostics(),
    });
  }

  close() {
    this.closed = true;
    this.closeDirectoryWatchers();
    this.dirty.clear();
    this.watchSignals.clear();
  }

  diagnostics() {
    const iso = (value) => Number.isFinite(value) ? new Date(value).toISOString() : undefined;
    return {
      active: !this.closed,
      startedAt: iso(this.startedAtMs),
      sessionsDir: this.sessionsDir,
      changeNotifications: this.observationPolicy.changeNotifications,
      reconcileIntervalMs: this.reconcileIntervalMs,
      activeFileHorizonMs: this.observationPolicy.activeFileHorizonMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      watcherCount: this.watchers.size,
      trackedFileCount: this.tracks.size,
      dirtyFileCount: this.dirty.size,
      watchEventCount: this.watchSequence,
      lastWatchEventAt: iso(this.lastWatchEventAtMs),
      lastWatchEventPath: this.lastWatchEventPath,
      lastReconcileAt: iso(this.lastReconcileAtMs),
      lastFileScanAt: iso(this.lastFileScanAtMs),
      lastScannedFile: this.lastScannedFile,
      reconcileCount: this.reconcileCount,
      lastReconcileDurationMs: this.lastReconcileDurationMs,
      lastReconciledFileCount: this.lastReconciledFileCount,
      lastRecentDirectoryCount: this.lastRecentDirectoryCount,
      recoveryCounts: { ...this.recoveryCounts },
      diagnosticFailureCount: this.diagnosticFailureCount,
    };
  }

  async emitDiagnostic(event) {
    try { await this.onDiagnostic(event); }
    catch { this.diagnosticFailureCount += 1; }
  }

  markDirty(file) {
    const path = resolve(file);
    const localPath = relative(this.sessionsDir, path);
    const insideSessions = localPath && localPath !== ".." && !localPath.startsWith(`..${sep}`) && !isAbsolute(localPath);
    if (extname(path) === ".jsonl" && insideSessions) {
      this.dirty.add(path);
    }
  }

  async drain() {
    await this.maybeReconcile();
    const files = [...this.dirty];
    this.dirty.clear();
    for (const file of files) {
      try { await this.scanFile(file); }
      catch (error) { await this.reportError(error, file); }
    }
    await this.flushPendingQuotas();
    await this.maybeHeartbeat();
  }

  async snapshotExisting() {
    const pending = [this.sessionsDir];
    while (pending.length) {
      const directory = pending.pop();
      this.startDirectoryWatcher(directory);
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); }
      catch { entries = []; }
      for (const entry of entries) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(file);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        let info;
        try { info = statSync(file, { throwIfNoEntry: false }); }
        catch (error) {
          await this.reportError(error, file);
          continue;
        }
        if (info) this.tracks.set(resolve(file), this.createTrack(file, info.size, info.mtimeMs));
      }
    }
  }

  startDirectoryWatchers(directories) {
    for (const directory of directories) this.startDirectoryWatcher(directory);
  }

  startDirectoryWatcher(directory) {
    const path = resolve(directory);
    if (this.closed || this.watchers.has(path)) return;
    let watcher;
    try {
      watcher = this.watchFactory(path, { persistent: false }, (eventType, filename) => {
        const nowMs = this.now();
        this.watchSequence += 1;
        this.lastWatchEventAtMs = nowMs;
        this.lastWatchEventPath = filename ? resolve(join(path, String(filename))) : path;
        if (!filename) {
          void this.discoverDirectory(path);
          return;
        }
        const changed = join(path, String(filename));
        if (extname(changed) === ".jsonl") {
          this.watchSignals.set(resolve(changed), {
            sequence: this.watchSequence,
            atMs: nowMs,
            eventType,
          });
          this.markDirty(changed);
        } else {
          void this.discoverDirectory(changed);
        }
      });
    } catch (error) {
      void this.reportError(error, path);
      return;
    }
    this.watchers.set(path, watcher);
    watcher.on?.("error", (error) => void this.recover(error));
  }

  closeDirectoryWatchers() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  async discoverDirectory(directory) {
    const path = resolve(directory);
    if (this.closed || this.discovering.has(path)) return;
    this.discovering.add(path);
    try {
      const info = await stat(path).catch(() => undefined);
      if (!info?.isDirectory()) {
        this.watchers.get(path)?.close();
        this.watchers.delete(path);
        return;
      }
      const tree = walkSessionTree(path);
      this.startDirectoryWatchers(tree.directories);
      await this.reconcileFiles(tree, { pruneMissing: false, source: "watch-discovery" });
    } catch (error) {
      await this.reportError(error, path);
    } finally {
      this.discovering.delete(path);
    }
  }

  async recover(error) {
    await this.reportError(error);
    if (this.closed || this.recovering) return;
    this.recovering = true;
    this.closeDirectoryWatchers();
    try {
      const tree = walkSessionTree(this.sessionsDir);
      this.startDirectoryWatchers(tree.directories);
      await this.reconcileFiles(tree, { source: "watcher-error-recovery" });
    } catch (recoveryError) {
      await this.reportError(recoveryError);
    } finally {
      this.recovering = false;
    }
  }

  createTrack(file, offset = 0, lastActivityAtMs = this.now()) {
    const path = resolve(file);
    return {
      offset,
      carry: "",
      sessionId: sessionIdFromPath(path),
      parentSessionId: undefined,
      profileName: undefined,
      turnStarted: offset > 0,
      pendingQuota: undefined,
      quotaHandled: false,
      consumedWatchSequence: this.watchSignals.get(path)?.sequence ?? 0,
      lastActivityAtMs,
    };
  }

  recoveryDiagnosis(file, fallback) {
    const path = resolve(file);
    const track = this.tracks.get(path);
    const signal = this.watchSignals.get(path);
    return signal?.sequence > (track?.consumedWatchSequence ?? 0)
      ? "notified_change_not_drained"
      : fallback;
  }

  async recordRecovery(diagnosis, details = {}) {
    this.recoveryCounts[diagnosis] = (this.recoveryCounts[diagnosis] ?? 0) + 1;
    await this.emitDiagnostic({
      event: "supervisor.global_watch.recovered",
      diagnosis,
      ...details,
      watchEventCount: this.watchSequence,
      lastWatchEventAt: Number.isFinite(this.lastWatchEventAtMs)
        ? new Date(this.lastWatchEventAtMs).toISOString()
        : undefined,
      lastWatchEventPath: this.lastWatchEventPath,
    });
  }

  async reconcileFiles(tree = undefined, options = {}) {
    const { files } = tree ?? walkSessionTree(this.sessionsDir);
    const found = options.pruneMissing === false ? undefined : new Set();
    for (const entry of files) {
      const file = resolve(entry);
      found?.add(file);
      let info;
      try { info = statSync(file, { throwIfNoEntry: false }); }
      catch (error) {
        await this.reportError(error, file);
        continue;
      }
      if (!info) continue;
      const track = this.tracks.get(file);
      if (!track) {
        const diagnosis = options.source === "periodic" && !this.dirty.has(file)
          ? this.recoveryDiagnosis(file, "new_file_notification_missing")
          : undefined;
        this.tracks.set(file, this.createTrack(file, 0, info.mtimeMs));
        this.dirty.add(file);
        if (diagnosis) {
          await this.recordRecovery(diagnosis, {
            transcriptPath: file,
            previousOffset: 0,
            actualSize: info.size,
          });
        }
      } else if (info.size !== track.offset) {
        if (options.source === "periodic" && !this.dirty.has(file)) {
          await this.recordRecovery(this.recoveryDiagnosis(file, "file_change_notification_missing"), {
            transcriptPath: file,
            previousOffset: track.offset,
            actualSize: info.size,
          });
        }
        this.dirty.add(file);
      }
    }
    if (found) {
      for (const file of this.tracks.keys()) {
        if (!found.has(file)) this.tracks.delete(file);
      }
    }
  }

  async reconcile() {
    const startedAtMs = this.now();
    const nowMs = startedAtMs;
    const recent = recentSessionTree(this.sessionsDir, nowMs);
    for (const directory of recent.directories) {
      const path = resolve(directory);
      if (this.watchers.has(path)) continue;
      await this.recordRecovery("directory_watcher_missing", { directoryPath: path });
      this.startDirectoryWatcher(path);
    }

    const files = new Set(recent.files.map((file) => resolve(file)));
    for (const [file, track] of this.tracks) {
      const signal = this.watchSignals.get(file);
      const hasUnconsumedSignal = signal?.sequence > (track.consumedWatchSequence ?? 0);
      const recentlyActive = nowMs - (track.lastActivityAtMs ?? 0)
        <= this.observationPolicy.activeFileHorizonMs;
      if (recentlyActive || hasUnconsumedSignal || this.dirty.has(file)) files.add(file);
    }
    await this.reconcileFiles({ files: [...files] }, { pruneMissing: false, source: "periodic" });
    this.lastReconcileAtMs = this.now();
    this.lastReconcileDurationMs = Math.max(0, this.lastReconcileAtMs - startedAtMs);
    this.lastReconciledFileCount = files.size;
    this.lastRecentDirectoryCount = recent.directories.length;
    this.reconcileCount += 1;
  }

  async maybeReconcile() {
    const nowMs = this.now();
    if (
      this.lastReconcileAtMs !== undefined
      && nowMs - this.lastReconcileAtMs < this.reconcileIntervalMs
    ) return;
    await this.reconcile();
  }

  async maybeHeartbeat() {
    const nowMs = this.now();
    if (
      this.lastHeartbeatAtMs !== undefined
      && nowMs - this.lastHeartbeatAtMs < this.heartbeatIntervalMs
    ) return;
    this.lastHeartbeatAtMs = nowMs;
    await this.emitDiagnostic({
      event: "supervisor.global_watch.heartbeat",
      ...this.diagnostics(),
    });
  }

  async reportError(error, file) {
    try { await this.onError(error, file); }
    catch { /* Logging failures must not disable transcript monitoring. */ }
  }

  async scanFile(file) {
    const info = await stat(file).catch(() => undefined);
    if (!info) {
      this.tracks.delete(file);
      return;
    }
    let track = this.tracks.get(file);
    if (!track) {
      track = this.createTrack(file, 0);
      this.tracks.set(file, track);
    }
    const scanWatchSequence = this.watchSignals.get(resolve(file))?.sequence
      ?? track.consumedWatchSequence;
    if (info.size < track.offset) {
      track.offset = 0;
      track.carry = "";
      track.profileName = undefined;
      track.parentSessionId = undefined;
      track.turnStarted = false;
      track.pendingQuota = undefined;
      track.quotaHandled = false;
    }
    if (info.size === track.offset) {
      track.consumedWatchSequence = scanWatchSequence;
      this.deleteConsumedWatchSignal(file, track);
      return;
    }

    const buffer = Buffer.alloc(info.size - track.offset);
    const handle = await open(file, "r");
    try { await handle.read(buffer, 0, buffer.length, track.offset); }
    finally { await handle.close(); }
    track.offset = info.size;
    track.consumedWatchSequence = scanWatchSequence;
    this.deleteConsumedWatchSignal(file, track);
    track.lastActivityAtMs = info.mtimeMs;
    this.lastFileScanAtMs = this.now();
    this.lastScannedFile = resolve(file);

    const text = track.carry + buffer.toString("utf8");
    const complete = text.endsWith("\n") || text.endsWith("\r");
    const lines = text.split(/\r?\n/);
    track.carry = complete ? "" : (lines.pop() ?? "");
    if (complete) lines.pop();

    for (const line of lines) {
      const lifecycle = parseLifecycle(line);
      if (lifecycle?.sessionId) {
        track.sessionId = lifecycle.sessionId;
        track.parentSessionId = lifecycle.parentSessionId;
        track.profileName = lifecycle.parentSessionId
          ? this.ownership.inherit(track.sessionId, lifecycle.parentSessionId)
          : this.ownership.owner(track.sessionId) ?? track.profileName;
      }
      if (lifecycle?.turnStarted) {
        track.turnStarted = true;
        track.profileName = track.parentSessionId
          ? (track.profileName ?? this.ownership.inherit(track.sessionId, track.parentSessionId))
          : await this.getActiveProfile();
        this.ownership.bind(track.sessionId, track.profileName);
        track.pendingQuota = undefined;
        track.quotaHandled = false;
        await this.emitDiagnostic({
          event: "supervisor.global_watch.turn_bound",
          transcriptPath: resolve(file),
          sessionId: track.sessionId,
          profile: track.profileName,
          offset: track.offset,
        });
      }

      const quota = parseCodexQuotaLine(line);
      if (!quota || !track.turnStarted || track.quotaHandled) continue;
      track.profileName ??= this.ownership.owner(track.sessionId)
        ?? this.ownership.inherit(track.sessionId, track.parentSessionId);
      if (!track.profileName) {
        track.pendingQuota = quota;
        continue;
      }
      await this.deliverQuota(file, track, quota);
    }
  }

  deleteConsumedWatchSignal(file, track) {
    const path = resolve(file);
    const signal = this.watchSignals.get(path);
    if (signal?.sequence <= (track.consumedWatchSequence ?? 0)) this.watchSignals.delete(path);
  }

  async deliverQuota(file, track, quota) {
    if (this.isManagedSession({ file, sessionId: track.sessionId })) {
      track.quotaHandled = true;
      track.pendingQuota = undefined;
      return;
    }
    track.quotaHandled = true;
    track.pendingQuota = undefined;
    await this.onQuota({
      file,
      sessionId: track.sessionId,
      profileName: track.profileName,
    }, quota);
  }

  async flushPendingQuotas() {
    for (const [file, track] of this.tracks) {
      if (!track.pendingQuota || track.quotaHandled) continue;
      track.profileName ??= this.ownership.owner(track.sessionId)
        ?? this.ownership.inherit(track.sessionId, track.parentSessionId);
      if (track.profileName) await this.deliverQuota(file, track, track.pendingQuota);
    }
  }
}
