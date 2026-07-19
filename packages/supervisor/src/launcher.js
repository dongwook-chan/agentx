import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { supervisorRequest } from "./client.js";
import { activeProfile } from "./quota.js";
import { productConfigDir } from "./paths.js";

function launcherId(product) { return `${product}-${process.pid}-${randomBytes(6).toString("hex")}`; }

export async function runLauncher({ product, executable, args, buildArgs, restartable = true, socketPath, policyCommand }) {
  const id = launcherId(product);
  const cwd = process.cwd();
  let child;
  let launchGeneration = 0;
  let paused = false;
  let restartRequested = false;
  let resumeRequested = false;
  let stopping = false;
  let resolveExit;
  let lastExitWasRequested = false;
  let finalCode = 0;
  let resolveResumeWait;
  let controlRequested;
  let currentArgs = [...args];
  let logPath;
  if (product === "agyx") {
    const logs = join(productConfigDir("agyx"), "logs");
    await mkdir(logs, { recursive: true, mode: 0o700 });
    logPath = join(logs, `session-${id}.log`);
  }
  const request = (payload) => supervisorRequest(payload, socketPath ? { socketPath } : {});
  await request({ command: "register", product, launcherId: id, launcherPid: process.pid, cwd, args, logPath, policyCommand, profileName: await activeProfile(product) });

  const launch = async () => {
    launchGeneration += 1;
    const generation = launchGeneration;
    const status = await request({ command: "status", launcherId: id });
    const record = status.record;
    currentArgs = await buildArgs({ originalArgs: args, currentArgs, record, logPath });
    const profileName = await activeProfile(product);
    child = spawn(executable, currentArgs, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, AGENTX_MANAGED: "1", AGENTX_LAUNCHER_ID: id, CDXX_LAUNCHER_ID: product === "cdxx" ? id : process.env.CDXX_LAUNCHER_ID },
    });
    lastExitWasRequested = false;
    await request({ command: "child", launcherId: id, childPid: child.pid, generation, profileName });
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        const finish = () => {
          resolveExit = undefined;
          resolve(code ?? (signal === "SIGINT" ? 130 : 143));
        };
        resolveExit = finish;
        if (restartable && !stopping && !restartRequested) {
          setTimeout(finish, 100);
        } else finish();
      });
    });
  };

  const stopChild = (signal = "SIGTERM") => {
    if (child?.exitCode === null && child?.signalCode === null) {
      lastExitWasRequested = true;
      child.kill(signal);
    }
  };
  const requestRestart = () => {
    paused = true;
    restartRequested = true;
    lastExitWasRequested = true;
    resolveExit?.();
    stopChild("SIGTERM");
    controlRequested?.();
  };
  const resume = () => {
    resumeRequested = true;
    paused = false;
    resolveResumeWait?.();
  };
  process.on("SIGUSR1", () => {
    requestRestart();
    void request({ command: "status", launcherId: id }).then((status) => {
      if (status.record?.reason !== "profile-switch") return;
      if (product === "agyx") process.stderr.write("[agyx] Profile switch requested; this agy session will restart with the active profile.\n");
      else process.stderr.write("[cdxx] Profile switch requested; this Codex session will restart with the active profile.\n");
    }).catch(() => undefined);
  });
  process.on("SIGUSR2", () => {
    resume();
    void request({ command: "status", launcherId: id }).then((status) => {
      if (status.record?.reason !== "profile-switch") return;
      if (product === "agyx") process.stderr.write("[agyx] Resuming agy session after profile switch.\n");
      else process.stderr.write("[cdxx] Resuming Codex session after profile switch.\n");
    }).catch(() => undefined);
  });
  process.on("SIGCONT", () => {
    resume();
    void request({ command: "status", launcherId: id }).then((status) => {
      if (status.record?.reason !== "profile-switch") return;
      if (product === "agyx") process.stderr.write("[agyx] Resuming agy session after profile switch.\n");
      else process.stderr.write("[cdxx] Resuming Codex session after profile switch.\n");
    }).catch(() => undefined);
  });
  process.on("SIGINT", () => { stopping = true; stopChild("SIGINT"); });
  process.on("SIGTERM", () => { stopping = true; stopChild("SIGTERM"); });

  const waitForResume = async () => {
    while (paused && !stopping && !resumeRequested) {
      const status = await request({ command: "status", launcherId: id }).catch(() => undefined);
      if (status?.record && !status.record.paused) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  try {
    while (true) {
      try {
        finalCode = await launch();
      } catch (error) {
        process.stderr.write(`[${product}] launcher error: ${error?.stack ?? error}\n`);
        throw error;
      }
      child = undefined;
      await request({ command: "exited", launcherId: id, generation: launchGeneration, code: finalCode });
      if (!restartRequested && !stopping && restartable) {
        await new Promise((resolve) => {
          controlRequested = resolve;
          const timer = setTimeout(resolve, 200);
          timer.unref?.();
        });
        controlRequested = undefined;
      }
      if (restartable) await new Promise((resolve) => setTimeout(resolve, 100));
      if (stopping || !restartable) break;
      if (restartRequested || lastExitWasRequested) {
        if (paused && !stopping && !resumeRequested) {
          await waitForResume();
        }
        if (stopping) break;
        resumeRequested = false;
        restartRequested = false;
        continue;
      }
      if (resumeRequested) { resumeRequested = false; continue; }
      if (!restartable || stopping) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (restartRequested || resumeRequested) continue;
      break;
    }
  } finally {
    await request({ command: "unregister", launcherId: id }).catch(() => undefined);
  }
  return finalCode;
}
