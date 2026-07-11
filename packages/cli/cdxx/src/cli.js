#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedLoginProfile, removeProfile, saveCurrentProfile, useProfile, readActiveAuthSummary } from "./auth.js";
import { clearExpiredQuota, effectiveYoloMode, loadState, saveState } from "./config.js";
import { decideCodexFailover } from "./failover_policy.js";
import { installShellIntegration, shellInit, shellIntegrationPath } from "./install.js";
import { buildCodexLaunchArgsFromState } from "./launch_args.js";
import { pauseAll, resumeAll, sessionRecords, withPausedAuthSwitch } from "./managed_sessions.js";
import { findRealCodex } from "./processes.js";
import { pickNextProfile, runCodexSession } from "./session.js";
import { recordQuotaForActiveProfile, scanCodexQuota, scanCodexSessions } from "./quota.js";
import { pickConfigKey, pickConfigValue, pickProfileForUse, printProfiles, printScanSummary } from "./ui.js";

const help = `cdxx - Codex CLI profile and quota helper

Preferred shell usage after 'cdxx install':
  codex login                    Protected Codex login; auto-save and activate profile
  codex x list                   List saved profiles
  codex x use [name]             Activate a saved profile
  codex x next                   Switch to next selectable profile
  codex x sessions               List supervised Codex sessions
  codex x pause | resume         Pause or resume supervised sessions
  codex x status                 Show wrapper status
  codex x scan                   Check quota via /status
  codex x config                 Configure wrapper settings interactively
  codex x config <key> [value]   Configure autoswitch/yolo
  codex x remove <name>          Delete a saved profile
  codex x import-current [name]  Import current $CODEX_HOME/auth.json as a profile
  codex --native ...             Bypass cdxx and run the real Codex CLI

Usage:
  cdxx dispatch -- [codex args]   Shell integration dispatcher
  cdxx install                    Install codex shell function
  cdxx shell-init                 Print shell function for current terminal
  cdxx session -- [codex args]    Run Codex with live quota failover
  cdxx import-current [name]      Save current $CODEX_HOME/auth.json as a profile
  cdxx login [name]               Run 'codex login', then save as profile
  cdxx use [name]                 Activate a saved profile
  cdxx next                       Switch to next selectable profile
  cdxx sessions                   List supervised Codex sessions
  cdxx pause | resume             Pause or resume supervised sessions
  cdxx list                       List profiles
  cdxx scan [--json] [--record] [--full] [--jsonl]
                                  Check quota via /status
  cdxx config [key] [value]       Configure wrapper settings
  cdxx remove <name>              Delete a saved profile
  cdxx status                     Show wrapper status`;

const wrapperHelp = `cdxx wrapper commands:
  codex login                    Protected login; auto-save and activate profile
  codex x list                   List saved profiles
  codex x use [name]             Activate a saved profile
  codex x next                   Switch to next selectable profile
  codex x sessions               List supervised Codex sessions
  codex x pause | resume         Pause or resume supervised sessions
  codex x status                 Show wrapper status
  codex x scan                   Check quota via /status
  codex x config                 Configure wrapper settings interactively
  codex x config list            Print wrapper settings
  codex x config get <key>       Print one setting
  codex x config set <key> <val> Set one setting
  codex x config <key> [value]   Set autoswitch/yolo, or pick value interactively
  codex x remove <name>          Delete a saved profile
  codex x import-current [name]  Import current active Codex auth as a profile
  codex --native ...             Bypass cdxx and run the real Codex CLI`;

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function requireOne(args, usage) {
  if (args.length !== 1) throw new Error(`Usage: ${usage}`);
  return args[0];
}

function optionalName(args, usage) {
  if (args.length > 1) throw new Error(`Usage: ${usage}`);
  return args[0];
}

function spawnInherited(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: options.env ?? process.env,
    });
    const previousListeners = new Map();
    let interruptedSignal;
    const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
    const cleanup = () => {
      for (const [signal, listeners] of previousListeners) {
        process.removeAllListeners(signal);
        for (const listener of listeners) process.on(signal, listener);
      }
    };
    const installSignalHandler = (signal) => {
      previousListeners.set(signal, process.listeners(signal));
      process.removeAllListeners(signal);
      process.on(signal, () => {
        interruptedSignal = signal;
        if (child.exitCode === null && !child.killed) child.kill(signal);
      });
    };
    for (const signal of Object.keys(signalNumbers)) installSignalHandler(signal);
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      const exitSignal = signal ?? interruptedSignal;
      resolve(code ?? (exitSignal ? 128 + (signalNumbers[exitSignal] ?? 0) : 1));
    });
  });
}

async function loginProfile(name, loginArgs = []) {
  const realCodex = await findRealCodex();
  const loginHome = await mkdtemp(join(tmpdir(), "cdxx-codex-login-"));
  try {
    return await withPausedSessions(async () =>
      await guardedLoginProfile(
        name,
        async () => await spawnInherited(realCodex, ["login", ...loginArgs], {
          env: { ...process.env, CODEX_HOME: loginHome },
        }),
        { candidateAuthPath: join(loginHome, "auth.json") },
      )
    );
  } finally {
    await rm(loginHome, { recursive: true, force: true });
  }
}

async function withPausedSessions(operation) {
  return await withPausedAuthSwitch(operation);
}

async function chooseProfileForUse() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Usage: cdxx use [name] or run 'cdxx use' in an interactive terminal.");
  }
  const state = await loadState();
  return await pickProfileForUse(state);
}

async function switchNext() {
  const state = await loadState();
  for (const profile of state.profiles) clearExpiredQuota(profile);
  const next = pickNextProfile(state);
  if (!next) throw new Error("No selectable profile found.");
  const result = await withPausedSessions(async () => await useProfile(next.name));
  console.log(`Activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
}

async function setAutoswitch(value) {
  const state = await loadState();
  if (value === undefined) {
    console.log(state.settings?.autoswitch ? "on" : "off");
    return;
  }
  if (!["on", "off"].includes(value)) throw new Error("Usage: cdxx autoswitch [on|off]");
  state.settings = state.settings ?? {};
  state.settings.autoswitch = value === "on";
  await saveState(state);
  console.log(`autoswitch ${value}`);
}

async function setYolo(value) {
  const state = await loadState();
  if (value === undefined) {
    console.log(`Yolo mode: ${effectiveYoloMode(state) ? "on" : "off"}`);
    return;
  }
  if (value !== "on" && value !== "off") throw new Error("Usage: cdxx yolo [on|off]");
  state.settings = state.settings ?? {};
  state.settings.yolo = value === "on";
  await saveState(state);
  console.log(`Yolo mode: ${value}`);
}

const configKeys = new Set(["autoswitch", "yolo"]);

function configValue(state, key) {
  if (key === "autoswitch") return state.settings?.autoswitch ? "on" : "off";
  if (key === "yolo") return effectiveYoloMode(state) ? "on" : "off";
  throw new Error("Usage: cdxx config [list|get|set|autoswitch|yolo]");
}

function printConfig(state) {
  console.log(`autoswitch ${configValue(state, "autoswitch")}`);
  console.log(`yolo ${configValue(state, "yolo")}`);
}

async function setConfigValue(key, value) {
  if (!configKeys.has(key)) throw new Error("Usage: cdxx config set <autoswitch|yolo> <on|off>");
  if (value !== "on" && value !== "off") throw new Error(`Usage: cdxx config ${key} [on|off]`);
  if (key === "autoswitch") await setAutoswitch(value);
  else await setYolo(value);
}

async function configure(args) {
  const state = await loadState();
  const subcommand = args.shift();
  if (!subcommand || subcommand === "list") {
    if (!subcommand && process.stdin.isTTY && process.stdout.isTTY) {
      const key = await pickConfigKey(state.settings ?? {});
      const value = await pickConfigValue(key, configValue(state, key) === "on");
      await setConfigValue(key, value);
      return 0;
    }
    if (args.length) throw new Error("Usage: cdxx config list");
    printConfig(state);
    return 0;
  }
  if (subcommand === "get") {
    const key = requireOne(args, "cdxx config get <autoswitch|yolo>");
    if (!configKeys.has(key)) throw new Error("Usage: cdxx config get <autoswitch|yolo>");
    console.log(configValue(state, key));
    return 0;
  }
  if (subcommand === "set") {
    const key = args.shift();
    const value = args.shift();
    if (!key || !value || args.length) throw new Error("Usage: cdxx config set <autoswitch|yolo> <on|off>");
    await setConfigValue(key, value);
    return 0;
  }
  if (!configKeys.has(subcommand)) {
    throw new Error("Usage: cdxx config [list|get|set|autoswitch|yolo]");
  }
  const value = args.shift();
  if (args.length) throw new Error(`Usage: cdxx config ${subcommand} [on|off]`);
  if (!value) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(configValue(state, subcommand));
      return 0;
    }
    await setConfigValue(subcommand, await pickConfigValue(subcommand, configValue(state, subcommand) === "on"));
    return 0;
  }
  await setConfigValue(subcommand, value);
  return 0;
}

function parseSupervisorPayload(encoded) {
  if (!encoded) throw new Error("Usage: cdxx _supervisor-failover <base64-json>");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

async function supervisorFailover(encoded) {
  const payload = parseSupervisorPayload(encoded);
  console.log(JSON.stringify(await decideCodexFailover(payload)));
  return 0;
}

function parseSupervisorLaunchArgs(encoded) {
  if (!encoded) throw new Error("Usage: cdxx _supervisor-launch-args <base64-json>");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

async function supervisorLaunchArgs(encoded) {
  const payload = parseSupervisorLaunchArgs(encoded);
  console.log(JSON.stringify({
    argv: await buildCodexLaunchArgsFromState(payload.args ?? []),
  }));
  return 0;
}

async function printStatus() {
  const state = await loadState();
  console.log(`active profile: ${state.activeProfile ?? "(none)"}`);
  try {
    const auth = await readActiveAuthSummary();
    console.log(`active auth: ${auth.email ?? auth.accountId ?? auth.authMode ?? "unknown"}`);
    console.log(`auth mode: ${auth.authMode ?? ""}`);
  } catch {
    console.log("active auth: missing");
  }
  console.log(`autoswitch: ${state.settings?.autoswitch ? "on" : "off"}`);
  console.log(`yolo: ${effectiveYoloMode(state) ? "on" : "off"}`);
  console.log(`real codex: ${await findRealCodex().catch(() => "(not found)")}`);
  console.log(`shell integration file: ${shellIntegrationPath()}`);
  console.log(`supervised sessions: ${(await sessionRecords()).length}`);
}

async function loadStateForDisplay() {
  const state = await loadState();
  for (const profile of state.profiles) clearExpiredQuota(profile);
  await saveState(state);
  return state;
}

async function printSessions() {
  const sessions = await sessionRecords();
  if (!sessions.length) {
    console.log("No supervised Codex sessions.");
    return;
  }
  for (const record of sessions) {
    console.log(
      `${record.id}  pid=${record.pid}`
      + `${record.childPid ? ` child=${record.childPid}` : ""}`
      + `  ${record.paused ? "paused" : "running"}`
      + `  cwd=${record.cwd}`
      + `${record.codexSessionId ? `  session=${record.codexSessionId}` : ""}`,
    );
  }
}

async function handleScanCommand(args) {
  const asJson = takeFlag(args, "--json");
  const full = takeFlag(args, "--full");
  const record = takeFlag(args, "--record");
  const jsonl = takeFlag(args, "--jsonl");
  if (args.length) throw new Error("Usage: cdxx scan [--json] [--record] [--full] [--jsonl]");
  const summary = jsonl
    ? await scanCodexSessions()
    : await scanCodexQuota({ reason: record ? "manual-record" : "explicit-scan" });
  if (record) await recordQuotaForActiveProfile(summary);
  if (asJson) {
    const payload = full ? summary : {
      ...summary,
      highWatermarkCount: summary.highWatermarks.length,
      highWatermarks: summary.highWatermarks.slice(-20),
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printScanSummary(summary);
  }
  return 0;
}

async function runNativeCodex(args) {
  return await spawnInherited(await findRealCodex(), args);
}

async function printCombinedHelp() {
  await runNativeCodex(["--help"]);
  console.log("");
  console.log(wrapperHelp);
}

async function runWrapperCommand(command, args) {
  switch (command) {
    case "login":
      return await loginProfile(optionalName(args, "cdxx login [name]"));
    case "import-current":
    case "save": {
      const name = optionalName(args, `cdxx ${command} [name]`);
      const result = await saveCurrentProfile(name);
      console.log(`Saved and activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
      return 0;
    }
    case "use": {
      const name = optionalName(args, "cdxx use [name]") ?? await chooseProfileForUse();
      if (!name) return 0;
      const result = await withPausedSessions(async () => await useProfile(name));
      console.log(`Activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
      return 0;
    }
    case "next":
      await switchNext();
      return 0;
    case "sessions":
      await printSessions();
      return 0;
    case "pause": {
      const records = await pauseAll();
      console.log(`Paused ${records.length} supervised session(s).`);
      return 0;
    }
    case "resume": {
      const records = await sessionRecords();
      await resumeAll(records);
      console.log(`Resumed ${records.length} supervised session(s).`);
      return 0;
    }
    case "list":
      printProfiles(await loadStateForDisplay());
      return 0;
    case "current": {
      const state = await loadState();
      console.log(state.activeProfile ?? "");
      return state.activeProfile ? 0 : 1;
    }
    case "scan": {
      return await handleScanCommand(args);
    }
    case "config":
      return await configure(args);
    case "autoswitch":
      await setAutoswitch(args.shift());
      if (args.length) throw new Error("Usage: cdxx autoswitch [on|off]");
      return 0;
    case "yolo":
      await setYolo(args.shift());
      if (args.length) throw new Error("Usage: cdxx yolo [on|off]");
      return 0;
    case "remove":
      await removeProfile(requireOne(args, "cdxx remove <name>"));
      console.log("Removed.");
      return 0;
    case "status":
      await printStatus();
      return 0;
    default:
      throw new Error(`Unknown wrapper command: ${command}\n\n${wrapperHelp}`);
  }
}

async function dispatchCodex(args) {
  if (args[0] === "--") args.shift();
  if (args[0] === "--native") return await runNativeCodex(args.slice(1));
  if (!args.length) return await runCodexSession([]);
  if (args[0] === "login") return await loginProfile(undefined, args.slice(1));
  if (args[0] === "x") {
    args.shift();
    const command = args.shift();
    if (!command || ["help", "-h", "--help"].includes(command)) {
      console.log(wrapperHelp);
      return 0;
    }
    return await runWrapperCommand(command, args);
  }
  if (["help", "-h", "--help"].includes(args[0])) {
    await printCombinedHelp();
    return 0;
  }
  return await runCodexSession(args);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || ["help", "-h", "--help"].includes(command)) {
    console.log(help);
    return 0;
  }

  switch (command) {
    case "install": {
      const path = await installShellIntegration();
      console.log(`Installed codex shell function in ${path}`);
      console.log(`Run: source ${path}`);
      return 0;
    }
    case "shell-init":
      console.log(shellInit());
      return 0;
    case "dispatch":
      return await dispatchCodex(args);
    case "session":
      if (args[0] === "--") args.shift();
      return await runCodexSession(args);
    case "save": {
      const name = optionalName(args, "cdxx save [name]");
      const result = await saveCurrentProfile(name);
      console.log(`Saved and activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
      return 0;
    }
    case "import-current": {
      const name = optionalName(args, "cdxx import-current [name]");
      const result = await saveCurrentProfile(name);
      console.log(`Saved and activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
      return 0;
    }
    case "login":
      return await loginProfile(optionalName(args, "cdxx login [name]"));
    case "use": {
      const name = optionalName(args, "cdxx use [name]") ?? await chooseProfileForUse();
      if (!name) return 0;
      const result = await withPausedSessions(async () => await useProfile(name));
      console.log(`Activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
      return 0;
    }
    case "next":
      await switchNext();
      return 0;
    case "sessions":
      await printSessions();
      return 0;
    case "pause": {
      const records = await pauseAll();
      console.log(`Paused ${records.length} supervised session(s).`);
      return 0;
    }
    case "resume": {
      const records = await sessionRecords();
      await resumeAll(records);
      console.log(`Resumed ${records.length} supervised session(s).`);
      return 0;
    }
    case "list":
      printProfiles(await loadStateForDisplay());
      return 0;
    case "current": {
      const state = await loadState();
      console.log(state.activeProfile ?? "");
      return state.activeProfile ? 0 : 1;
    }
    case "scan": {
      return await handleScanCommand(args);
    }
    case "autoswitch":
      await setAutoswitch(args.shift());
      if (args.length) throw new Error("Usage: cdxx autoswitch [on|off]");
      return 0;
    case "yolo":
      await setYolo(args.shift());
      if (args.length) throw new Error("Usage: cdxx yolo [on|off]");
      return 0;
    case "config":
      return await configure(args);
    case "remove":
      await removeProfile(requireOne(args, "cdxx remove <name>"));
      return 0;
    case "status":
      await printStatus();
      return 0;
    case "_supervisor-failover":
      return await supervisorFailover(args.shift());
    case "_supervisor-launch-args":
      return await supervisorLaunchArgs(args.shift());
    default:
      throw new Error(`Unknown command: ${command}\n\n${help}`);
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`cdxx: ${error.message}`);
  process.exitCode = 1;
});
