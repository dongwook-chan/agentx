import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { detectAgyConversation, parseAgyModelLine, parseAgyQuotaLine, parseCodexQuotaLine, recordAgyQuota } from "./quota.js";
import { productConfigDir, supervisorSocketPath, supervisorStatePath } from "./paths.js";

function nowIso() { return new Date().toISOString(); }

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export class SupervisorDaemon {
  constructor(options = {}) {
    this.socketPath = options.socketPath ?? supervisorSocketPath();
    this.statePath = options.statePath ?? supervisorStatePath();
    this.sessions = new Map();
    this.failover = options.failover ?? this.runFailover.bind(this);
    this.timer = undefined;
    this.server = undefined;
  }

  async start() {
    const runtime = dirname(this.socketPath);
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    await chmod(runtime, 0o700).catch(() => undefined);
    await rm(this.socketPath, { force: true });
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600).catch(() => undefined);
    await this.persist();
    this.timer = setInterval(() => void this.tick(), 200);
    this.timer.unref?.();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    await rm(this.socketPath, { force: true });
    await rm(this.statePath, { force: true });
  }

  handleSocket(socket) {
    let input = "";
    let handled = false;
    socket.setEncoding("utf8");
    const respond = async () => {
      if (handled) return;
      handled = true;
      let reply;
      try { reply = await this.handle(JSON.parse(input)); }
      catch (error) { reply = { ok: false, error: error?.message ?? String(error) }; }
      if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
    };
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) void respond();
    });
    socket.on("error", () => undefined);
    socket.on("end", () => {
      if (input.trim()) void respond();
    });
  }

  publicRecord(session) {
    return {
      id: session.launcherId,
      launcherId: session.launcherId,
      product: session.product,
      pid: process.pid,
      launcherPid: session.launcherPid,
      childPid: session.childPid,
      cwd: session.cwd,
      args: session.args,
      socketPath: this.socketPath,
      paused: session.paused,
      restartable: true,
      startedAt: session.startedAt,
      codexSessionId: session.sessionId,
      conversationId: session.conversationId,
      transcriptPath: session.transcriptPath,
      logPath: session.logPath,
      currentModelLabel: session.modelLabel,
      currentQuotaScope: session.scope,
      reason: session.reason,
    };
  }

  async handle(request) {
    switch (request.command) {
      case "ping": return { ok: true, pid: process.pid };
      case "register": {
        if (!request.launcherId || !["agyx", "cdxx"].includes(request.product)) throw new Error("Invalid launcher registration.");
        const existing = this.sessions.get(request.launcherId) ?? {};
        const session = {
          ...existing,
          launcherId: request.launcherId,
          product: request.product,
          launcherPid: request.launcherPid,
          childPid: request.childPid,
          cwd: request.cwd,
          args: request.args ?? [],
          logPath: request.logPath ?? existing.logPath,
          transcriptPath: request.transcriptPath ?? existing.transcriptPath,
          sessionId: request.sessionId ?? existing.sessionId,
          conversationId: request.conversationId ?? existing.conversationId,
          profileName: request.profileName ?? existing.profileName,
          policyCommand: request.policyCommand ?? existing.policyCommand,
          startedAt: existing.startedAt ?? nowIso(),
          paused: false,
          offset: request.offset ?? existing.offset ?? 0,
          carry: existing.carry ?? "",
          quotaHandled: false,
          modelLabel: existing.modelLabel,
          scope: existing.scope ?? "unknown",
        };
        this.sessions.set(session.launcherId, session);
        await this.persist();
        return { ok: true, record: this.publicRecord(session) };
      }
      case "hook": {
        const session = request.launcherId ? this.sessions.get(request.launcherId) : undefined;
        if (!session) return { ok: true, registered: false };
        if (request.sessionId) session.sessionId = request.sessionId;
        if (request.transcriptPath) {
          const changed = session.transcriptPath !== request.transcriptPath;
          session.transcriptPath = request.transcriptPath;
          if (changed || session.offset === undefined || session.offset === 0) {
            session.offset = (await stat(request.transcriptPath).catch(() => undefined))?.size ?? 0;
            session.carry = "";
          }
        }
        if (request.cwd) session.cwd = request.cwd;
        await this.persist();
        return { ok: true, registered: true, record: this.publicRecord(session) };
      }
      case "child": {
        const session = this.sessions.get(request.launcherId);
        if (!session) throw new Error(`Unknown launcher: ${request.launcherId}`);
        session.childPid = request.childPid;
        session.generation = request.generation;
        if (request.profileName) session.profileName = request.profileName;
        session.paused = false;
        session.quotaHandled = false;
        await this.persist();
        return { ok: true };
      }
      case "exited": {
        const session = this.sessions.get(request.launcherId);
        if (session && (request.generation === undefined || request.generation === session.generation)) {
          session.childPid = undefined;
          session.exitCode = request.code;
          await this.persist();
          if (session.resumeAfterPause) {
            session.resumeAfterPause = false;
            process.kill(session.launcherPid, "SIGCONT");
          }
        }
        return { ok: true };
      }
      case "unregister": {
        this.sessions.delete(request.launcherId);
        await this.persist();
        return { ok: true };
      }
      case "sessions": {
        await this.pruneStaleSessions();
        return { ok: true, records: [...this.sessions.values()].map((entry) => this.publicRecord(entry)) };
      }
      case "status": {
        const session = this.sessions.get(request.launcherId);
        if (session && !processAlive(session.launcherPid)) {
          this.sessions.delete(request.launcherId);
          await this.persist();
          return { ok: false, error: "session not found" };
        }
        return session ? { ok: true, record: this.publicRecord(session) } : { ok: false, error: "session not found" };
      }
      case "pause": return await this.commandLauncher(request.launcherId, "pause", request.reason);
      case "resume": return await this.commandLauncher(request.launcherId, "resume", request.reason);
      case "resume-all": {
        const records = [];
        for (const session of this.sessions.values()) {
          if (request.product && session.product !== request.product) continue;
          if (session.paused) records.push((await this.commandLauncher(session.launcherId, "resume", request.reason)).record);
          else records.push(this.publicRecord(session));
        }
        return { ok: true, records };
      }
      default: throw new Error(`Unknown supervisor command: ${request.command}`);
    }
  }

  async commandLauncher(launcherId, command, reason) {
    const session = this.sessions.get(launcherId);
    if (!session) throw new Error(`Unknown launcher: ${launcherId}`);
    if (!processAlive(session.launcherPid)) {
      this.sessions.delete(launcherId);
      await this.persist();
      return { ok: true, stale: true, record: { ...this.publicRecord(session), childPid: undefined, paused: true } };
    }
    if (command === "resume" && session.paused && !session.childPid) {
      session.reason = reason;
      session.paused = false;
      await this.persist();
      try { process.kill(session.launcherPid, "SIGCONT"); }
      catch (error) {
        if (error?.code === "ESRCH") {
          this.sessions.delete(launcherId);
          await this.persist();
          return { ok: true, stale: true, record: { ...this.publicRecord(session), childPid: undefined, paused: true } };
        }
        throw error;
      }
      session.quotaHandled = false;
      await this.persist();
      return { ok: true, record: this.publicRecord(session) };
    }
    const signal = command === "pause" ? "SIGUSR1" : "SIGCONT";
    if (command === "pause") session.resumeAfterPause = false;
    session.reason = reason;
    try { process.kill(session.launcherPid, signal); }
    catch (error) {
      if (error?.code === "ESRCH") {
        this.sessions.delete(launcherId);
        await this.persist();
        return { ok: true, stale: true, record: { ...this.publicRecord(session), childPid: undefined, paused: true } };
      }
      throw error;
    }
    session.paused = command === "pause";
    if (command !== "pause") {
      if (session.childPid) {
        session.resumeAfterPause = true;
        await this.persist();
        return { ok: true, record: this.publicRecord(session) };
      }
      session.quotaHandled = false;
    }
    await this.persist();
    return { ok: true, record: this.publicRecord(session) };
  }

  async persist() {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    const value = { pid: process.pid, socketPath: this.socketPath, startedAt: nowIso(), sessions: [...this.sessions.values()].map((entry) => this.publicRecord(entry)) };
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  async pruneStaleSessions() {
    let changed = false;
    for (const [launcherId, session] of this.sessions) {
      if (processAlive(session.launcherPid)) continue;
      this.sessions.delete(launcherId);
      changed = true;
    }
    if (changed) await this.persist();
  }

  async tick() {
    await this.pruneStaleSessions();
    for (const session of this.sessions.values()) {
      try { await this.scan(session); }
      catch (error) { await this.logEvent(session.product, { event: "supervisor.scan.failed", launcherId: session.launcherId, error: error?.message ?? String(error) }); }
    }
  }

  async scan(session) {
    const file = session.product === "agyx" ? session.logPath : session.transcriptPath;
    if (!file) return;
    const info = await stat(file).catch(() => undefined);
    if (!info) return;
    if (info.size < session.offset) { session.offset = 0; session.carry = ""; }
    if (info.size === session.offset) return;
    const buffer = Buffer.alloc(info.size - session.offset);
    const handle = await import("node:fs/promises").then(({ open }) => open(file, "r"));
    try { await handle.read(buffer, 0, buffer.length, session.offset); }
    finally { await handle.close(); }
    session.offset = info.size;
    const text = session.carry + buffer.toString("utf8");
    const complete = text.endsWith("\n") || text.endsWith("\r");
    const lines = text.split(/\r?\n/);
    session.carry = complete ? "" : (lines.pop() ?? "");
    if (complete) lines.pop();
    if (session.product === "agyx") {
      session.conversationId = detectAgyConversation(text) ?? session.conversationId;
      for (const line of lines) {
        const model = parseAgyModelLine(line);
        if (model) { session.modelLabel = model.label; session.scope = model.scope; }
        const quota = parseAgyQuotaLine(line);
        if (quota && !session.quotaHandled) {
          session.quotaHandled = true;
          const event = { ...quota, scope: session.scope ?? "unknown", modelLabel: session.modelLabel };
          await recordAgyQuota(session.profileName, event);
          await this.failover(session, event);
        }
      }
    } else {
      for (const line of lines) {
        const quota = parseCodexQuotaLine(line);
        if (quota && !session.quotaHandled) {
          session.quotaHandled = true;
          await this.failover(session, quota);
        }
      }
    }
    await this.persist();
  }

  async runFailover(session, event) {
    const command = session.policyCommand ? process.execPath : (session.product === "agyx" ? "agyx" : "cdxx");
    const args = session.product === "agyx"
      ? ["_auto-next", event.scope ?? "unknown"]
      : ["_supervisor-failover", Buffer.from(JSON.stringify({ profileName: session.profileName, sessionId: session.sessionId, ...event })).toString("base64")];
    const launchArgs = session.policyCommand ? [session.policyCommand, ...args] : args;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(command, launchArgs, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    await this.logEvent(session.product, { event: "supervisor.failover", launcherId: session.launcherId, code: output.code, stdout: output.stdout.trim(), stderr: output.stderr.trim() });
  }

  async logEvent(product, event) {
    const path = join(productConfigDir(product), "events.jsonl");
    await mkdir(productConfigDir(product), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify({ timestamp: nowIso(), product, emitter: "agentx-supervisor", ...event })}\n`, { mode: 0o600 });
  }
}

export async function runDaemon() {
  const daemon = new SupervisorDaemon();
  await daemon.start();
  const stop = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}
