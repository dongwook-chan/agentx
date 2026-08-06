import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { createJsonRpcUnixProxy } from "@dong-/agentx-supervisor";
import { ensureDir, runtimeDir } from "./config.js";

function capture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => {
      if (output.length < 256 * 1024) output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 5000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output, code });
    });
  });
}

export async function probeCodexRemoteSupport(executable, options = {}) {
  const run = options.capture ?? capture;
  const cli = await run(executable, ["--help"], options);
  if (!cli.ok || !/(?:^|\s)--remote(?:\s|<)/m.test(cli.output)) {
    return { supported: false, reason: "The installed Codex CLI does not expose the --remote option." };
  }
  const appServer = await run(executable, ["app-server", "--help"], options);
  if (!appServer.ok || !/(?:^|\s)--listen(?:\s|<)/m.test(appServer.output)) {
    return { supported: false, reason: "The installed Codex CLI does not expose a listen-capable app-server." };
  }
  return { supported: true };
}

function socketReachable(socketPath, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

async function acquireDirectoryLock(lockPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const staleAfterMs = Math.max(30_000, timeoutMs * 2);
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
      }), { mode: 0o600 });
      return async () => await rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      let lockStat;
      try { owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")); }
      catch { /* The creator may still be writing the owner file. */ }
      try { lockStat = await stat(lockPath); }
      catch { continue; }
      const ageMs = Date.now() - (owner?.createdAt ?? lockStat.mtimeMs);
      if ((owner?.pid && !processAlive(owner.pid)) || ageMs > staleAfterMs) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for the Codex app-server lock at ${lockPath}.`);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function readBackendState(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return undefined; }
}

async function writeBackendState(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function processStartTime(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(") ") + 2).trim().split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}

async function backendMatchesState(state) {
  if (!processAlive(state?.pid)) return false;
  const currentStartTime = await processStartTime(state.pid);
  if (state.processStartTime && currentStartTime) {
    return state.processStartTime === currentStartTime;
  }
  try {
    const commandLine = (await readFile(`/proc/${state.pid}/cmdline`)).toString("utf8").split("\0");
    return commandLine.includes("app-server")
      && commandLine.includes("--listen")
      && commandLine.includes(`unix://${state.socketPath}`);
  } catch {
    return false;
  }
}

async function stopOwnedBackend(state) {
  if (!await backendMatchesState(state)) return;
  try { process.kill(state.pid, "SIGTERM"); }
  catch { return; }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && processAlive(state.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processAlive(state.pid)) {
    try { process.kill(state.pid, "SIGKILL"); }
    catch { /* The process exited between checks. */ }
  }
}

export async function ensureCodexAppServer(executable, options = {}) {
  await ensureDir(runtimeDir);
  const socketPath = options.socketPath ?? join(runtimeDir, "app-server.sock");
  const statePath = options.statePath ?? join(runtimeDir, "app-server.json");
  const desiredProfile = options.profileName;
  if (options.managedBackend === false && await socketReachable(socketPath)) return socketPath;
  const currentState = await readBackendState(statePath);
  if (
    await socketReachable(socketPath)
    && currentState?.executable === executable
    && (!desiredProfile || currentState.profileName === desiredProfile)
  ) return socketPath;
  const release = await acquireDirectoryLock(`${socketPath}.lock`, options.lockTimeoutMs);
  try {
    const lockedState = await readBackendState(statePath);
    if (
      await socketReachable(socketPath)
      && lockedState?.executable === executable
      && (!desiredProfile || lockedState.profileName === desiredProfile)
    ) return socketPath;
    await stopOwnedBackend(lockedState);
    await rm(socketPath, { force: true });
    const child = spawn(executable, ["app-server", "--listen", `unix://${socketPath}`], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    const deadline = Date.now() + (options.startTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      if (await socketReachable(socketPath)) {
        await writeBackendState(statePath, {
          pid: child.pid,
          processStartTime: await processStartTime(child.pid),
          executable,
          profileName: desiredProfile,
          socketPath,
          startedAt: new Date().toISOString(),
        });
        return socketPath;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try { child.kill("SIGTERM"); }
    catch { /* The failed child may already have exited. */ }
    throw new Error(`Codex app-server did not become ready at ${socketPath}.`);
  } finally {
    await release();
  }
}

function jsonMessage(data, isBinary) {
  if (isBinary) return undefined;
  try { return JSON.parse(Buffer.from(data).toString("utf8")); }
  catch { return undefined; }
}

function requestKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

export async function createCodexRemoteTransport(options) {
  const backendSocketPath = await ensureCodexAppServer(options.executable, options);
  const proxySocketPath = options.proxySocketPath
    ?? join(runtimeDir, `app-server-proxy-${options.launcherId}.sock`);
  const threadRequests = new Set();
  const proxy = await createJsonRpcUnixProxy({
    socketPath: proxySocketPath,
    backendSocketPath,
    onMessage: async ({ direction, data, isBinary }) => {
      const message = jsonMessage(data, isBinary);
      if (!message) return;
      if (
        direction === "client-to-server"
        && ["thread/start", "thread/resume", "thread/fork"].includes(message.method)
        && message.id !== undefined
      ) {
        threadRequests.add(requestKey(message.id));
        return;
      }
      if (direction !== "server-to-client") return;
      const key = message.id === undefined ? undefined : requestKey(message.id);
      if (key && threadRequests.delete(key)) {
        const thread = message.result?.thread;
        const sessionId = thread?.sessionId ?? thread?.id;
        if (sessionId) {
          await options.request({
            command: "identity",
            launcherId: options.launcherId,
            sessionId,
            threadId: thread?.id,
            cwd: options.cwd,
          });
        }
      }
      if (["error", "turn/completed", "account/rateLimits/updated"].includes(message.method)) {
        await options.request({
          command: "observe",
          launcherId: options.launcherId,
          message,
        });
      }
    },
  });
  return {
    kind: "codex-app-server",
    remoteUrl: `unix://${proxy.socketPath}`,
    beforeLaunch: async ({ profileName }) => {
      await ensureCodexAppServer(options.executable, { ...options, profileName });
    },
    close: () => proxy.close(),
  };
}

export function withCodexRemote(args, remoteUrl) {
  if (!remoteUrl) return [...args];
  if (args.some((argument) => argument === "--remote" || argument.startsWith("--remote="))) {
    throw new Error("Custom --remote endpoints cannot be used in an agentx-managed Codex session. Use 'codex --native' instead.");
  }
  return ["--remote", remoteUrl, ...args];
}
