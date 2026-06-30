#!/usr/bin/env node
import { spawn } from "node:child_process";
import { removeProfile, saveCurrentProfile, useProfile, readActiveAuthSummary } from "./auth.js";
import { clearExpiredQuota, effectiveYoloMode, loadState, saveState } from "./config.js";
import { decideCodexFailover } from "./failover_policy.js";
import { installShellIntegration, shellInit } from "./install.js";
import { buildCodexLaunchArgsFromState } from "./launch_args.js";
import { findRealCodex } from "./processes.js";
import { pickNextProfile, runCodexSession } from "./session.js";
import { recordQuotaForActiveProfile, scanCodexSessions } from "./quota.js";
import { pickProfileForUse, printProfiles, printScanSummary } from "./ui.js";

const help = `cdxx - Codex CLI profile and quota helper

Usage:
  cdxx install                    Install codex shell function
  cdxx shell-init                 Print shell function for current terminal
  cdxx session -- [codex args]    Run Codex with live quota failover
  cdxx save [name]                Save current $CODEX_HOME/auth.json as a profile
  cdxx login [name]               Run 'codex login', then save as profile
  cdxx use [name]                 Activate a saved profile
  cdxx next                       Switch to next selectable profile
  cdxx list                       List profiles
  cdxx current                    Print active profile
  cdxx scan [--json] [--full] [--record]
                                  Scan local Codex sessions
  cdxx autoswitch [on|off]        Toggle live quota failover/autoswitch
  cdxx yolo [on|off]              Auto-bypass Codex approvals/sandbox (default: on)
  cdxx remove <name>              Delete a saved profile
  cdxx status                     Show active auth summary and profiles`;

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

function spawnInherited(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: process.cwd(), env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

async function loginProfile(name) {
  const realCodex = await findRealCodex();
  const code = await spawnInherited(realCodex, ["login"]);
  if (code !== 0) return code;
  const result = await saveCurrentProfile(name);
  console.log(`Saved and activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
  return 0;
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
  const result = await useProfile(next.name);
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
  console.log("");
  printProfiles(state);
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
    case "session":
      if (args[0] === "--") args.shift();
      return await runCodexSession(args);
    case "save": {
      const name = optionalName(args, "cdxx save [name]");
      const result = await saveCurrentProfile(name);
      console.log(`Saved and activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
      return 0;
    }
    case "login":
      return await loginProfile(optionalName(args, "cdxx login [name]"));
    case "use": {
      const name = optionalName(args, "cdxx use [name]") ?? await chooseProfileForUse();
      if (!name) return 0;
      const result = await useProfile(name);
      console.log(`Activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
      return 0;
    }
    case "next":
      await switchNext();
      return 0;
    case "list":
      printProfiles(await loadState());
      return 0;
    case "current": {
      const state = await loadState();
      console.log(state.activeProfile ?? "");
      return state.activeProfile ? 0 : 1;
    }
    case "scan": {
      const asJson = takeFlag(args, "--json");
      const full = takeFlag(args, "--full");
      const record = takeFlag(args, "--record");
      if (args.length) throw new Error("Usage: cdxx scan [--json] [--full] [--record]");
      const summary = await scanCodexSessions();
      if (record) await recordQuotaForActiveProfile(summary);
      if (asJson) {
        const payload = full ? summary : {
          ...summary,
          highWatermarkCount: summary.highWatermarks.length,
          highWatermarks: summary.highWatermarks.slice(-20),
        };
        console.log(JSON.stringify(payload, null, 2));
      }
      else printScanSummary(summary);
      return 0;
    }
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
