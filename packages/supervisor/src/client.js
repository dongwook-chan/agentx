import { connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { supervisorSocketPath } from "./paths.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

export async function sendSupervisor(request, options = {}) {
  const socketPath = options.socketPath ?? supervisorSocketPath();
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let input = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to agentx supervisor at ${socketPath}.`));
    }, options.timeoutMs ?? 2000);
    timeout.unref?.();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("error", (error) => finish(reject, error));
    socket.on("close", () => {
      try { finish(resolve, JSON.parse(input)); }
      catch { finish(reject, new Error(`Invalid response from agentx supervisor at ${socketPath}.`)); }
    });
  });
}

export async function ensureSupervisor(options = {}) {
  try {
    const reply = await sendSupervisor({ command: "ping" }, options);
    if (reply?.ok) return reply;
  } catch {
    // Start the singleton below.
  }
  const socketPath = options.socketPath ?? supervisorSocketPath();
  await import("node:fs/promises").then(({ rm }) => rm(socketPath, { force: true })).catch(() => undefined);
  const child = spawn(process.execPath, [cliPath, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AGENTX_SUPERVISOR_SOCKET: socketPath },
  });
  child.unref();
  const deadline = Date.now() + (options.startTimeoutMs ?? 5000);
  let lastError;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const reply = await sendSupervisor({ command: "ping" }, options);
      if (reply?.ok) return reply;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Agentx supervisor did not start.");
}

export async function supervisorRequest(request, options = {}) {
  await ensureSupervisor(options);
  const reply = await sendSupervisor(request, options);
  if (!reply?.ok) throw new Error(reply?.error ?? "Agentx supervisor request failed.");
  return reply;
}
