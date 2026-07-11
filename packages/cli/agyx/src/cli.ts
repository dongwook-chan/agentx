#!/usr/bin/env node
import { spawn } from "node:child_process";
import { select } from "@inquirer/prompts";
import {
  activateProfile,
  activeQuotaScopes,
  autoSwitchAfterQuota,
  autoSwitchAfterQuotaAction,
  loginProfile,
  pauseAll,
  resumeAll,
  saveCurrent,
  setAllowIneligibleActivation,
  setAutoSwitchMode,
  sessionRecords,
  switchProfile,
  switchToNextProfile,
  verifyAllProfiles,
  withAuthSwitchLock,
} from "./coordinator.js";
import {
  installShellIntegration,
  shellInit,
  shellIntegrationInstalled,
  shellIntegrationPath,
} from "./install.js";
import { keychain } from "./keychain.js";
import { buildAgyLaunchArgs } from "./launch_args.js";
import { maybeRunOnboarding } from "./onboarding.js";
import { findRealAgy } from "./processes.js";
import {
  AutoSwitchMode,
  effectiveAllowIneligibleActivation,
  effectiveAutoSwitchMode,
  effectiveYoloMode,
  loadState,
  saveState,
  validateProfileName,
} from "./config.js";
import {
  createUsageTranscriptState,
  parseUsageTranscriptAggregates,
  QuotaScope,
  UsageTranscriptState,
} from "./quota.js";
import { runNativeSupervisor } from "./native.js";
import { runUsageProbe } from "./usage_probe.js";
import {
  confirmAction,
  decideProfileUse,
  pickAutoSwitchMode,
  pickProfileAction,
  printProfileTable,
  promptText,
} from "./ui.js";

const help = `agyx — multi-account session supervisor for Antigravity CLI

Preferred shell usage after 'agyx install':
  agy login                            Protected Antigravity login; auto-save and activate profile
  agy x list                           List saved profiles
  agy x use [name]                     Activate a saved profile
  agy x next                           Switch to next selectable profile
  agy x scan                           Check quota via /usage
  agy x status                         Show wrapper status
  agy x config                         Configure wrapper settings interactively
  agy x config <key> [value]           Configure autoswitch/ineligible/yolo
  agy x remove <name>                  Delete a saved profile
  agy x import-current [name]          Import current active agy credential as a profile
  agy --native ...                     Bypass agyx and run the real agy CLI

Usage:
  agyx dispatch -- [agy options]        Shell integration dispatcher
  agyx install                         Install agy shell function
  agyx session -- [agy options]        Run agy under the native restartable supervisor
  agyx import-current [name] [--email EMAIL]
                                       Save the current active account
  agyx login [name] [--email EMAIL] [--no-resume]
                                       Pause all sessions and add an account
  agyx use [name]                      Switch account and resume every session
  agyx next                            Rotate to the next selectable account
  agyx scan [--json] [--record]        Check quota via /usage
  agyx config [key] [value]            Configure wrapper settings
  agyx list [--verify]                 List profiles; optionally verify saved credentials
  agyx status                          Show wrapper status
  agyx sessions                        List supervised terminal sessions
  agyx pause | resume                  Pause or resume all supervised sessions
  agyx rename <old> <new>              Rename a saved profile
  agyx remove <name>                   Delete a saved profile
  agyx shell-init                      Print the shell integration function
  agyx doctor                          Diagnose the installation

All arguments passed through "agy" are forwarded to the real agy executable.
Non-interactive --print/--prompt commands are not automatically restarted.`;

const wrapperHelp = `agyx wrapper commands:
  agy login                            Protected login; auto-save and activate profile
  agy x list                           List saved profiles
  agy x use [name]                     Activate a saved profile
  agy x next                           Switch to next selectable profile
  agy x scan                           Check quota via /usage
  agy x status                         Show wrapper status
  agy x config                         Configure wrapper settings interactively
  agy x config list                    Print wrapper settings
  agy x config get <key>               Print one setting
  agy x config set <key> <val>         Set one setting
  agy x config <key> [value]           Set autoswitch/ineligible/yolo, or pick value interactively
  agy x remove <name>                  Delete a saved profile
  agy x rename <old> <new>             Rename a saved profile
  agy x import-current [name]          Import current active agy credential as a profile
  agy --native ...                     Bypass agyx and run the real agy CLI`;

function printSwitchResult(result: { name: string; email?: string; alreadyActive?: boolean }): void {
  if (result.alreadyActive) {
    console.log(
      `Profile '${result.name}' is already active.`
      + (result.email ? ` (${result.email})` : ""),
    );
    return;
  }
  console.log(
    `Activated profile '${result.name}'`
    + (result.email ? ` (${result.email})` : "")
    + " and resumed all sessions.",
  );
}

function printUsageScanResult(result: Awaited<ReturnType<typeof runUsageProbe>>): void {
  console.log("source: usage");
  if (result.profileName) console.log(`profile: ${result.profileName}`);
  console.log(`recorded: ${result.recorded ? "yes" : "no"}`);
  if (result.skipped) {
    console.log(`skipped: ${result.reason ?? "yes"}`);
    return;
  }
  if (!result.ok) {
    console.log(`error: ${result.error ?? "unknown"}`);
    return;
  }
  if (!result.aggregates.length) {
    console.log("scopes: none");
    return;
  }
  for (const aggregate of result.aggregates) {
    const parts = [
      `${aggregate.scope}: ${aggregate.status}`,
      aggregate.remainingPercent === undefined ? undefined : `${aggregate.remainingPercent}% left`,
      aggregate.resetAt ? `reset ${aggregate.resetAt}` : undefined,
      aggregate.modelLabel,
    ].filter(Boolean);
    console.log(parts.join("  "));
  }
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args.splice(index, 2)[1];
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOptionalName(args: string[], usage: string): string | undefined {
  if (args.length > 1) throw new Error(`Usage: ${usage}`);
  return args.shift();
}

function parseAutoSwitchMode(value: string): AutoSwitchMode {
  if (["off", "provider-first", "all-providers"].includes(value)) {
    return value as AutoSwitchMode;
  }
  throw new Error("Usage: agyx autoswitch [off|provider-first|all-providers]");
}

function parseIneligibleMode(value: string): boolean {
  if (value === "allow") return true;
  if (value === "block") return false;
  throw new Error("Usage: agyx ineligible [allow|block]");
}

function spawnInherited(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

function parseQuotaScope(value: string | undefined): QuotaScope {
  if (value === "claude" || value === "gemini" || value === "gpt-oss" || value === "unknown") {
    return value;
  }
  return "unknown";
}

type ConfigKey = "autoswitch" | "ineligible" | "yolo";

const configKeys = new Set<string>(["autoswitch", "ineligible", "yolo"]);

function configValue(state: Awaited<ReturnType<typeof loadState>>, key: ConfigKey): string {
  if (key === "autoswitch") return effectiveAutoSwitchMode(state);
  if (key === "ineligible") return effectiveAllowIneligibleActivation(state) ? "allow" : "block";
  return effectiveYoloMode(state) ? "on" : "off";
}

function printConfig(state: Awaited<ReturnType<typeof loadState>>): void {
  console.log(`autoswitch ${configValue(state, "autoswitch")}`);
  console.log(`ineligible ${configValue(state, "ineligible")}`);
  console.log(`yolo ${configValue(state, "yolo")}`);
}

async function pickConfigKey(state: Awaited<ReturnType<typeof loadState>>): Promise<ConfigKey | undefined> {
  try {
    return await select<ConfigKey>({
      message: "Select setting",
      choices: [
        {
          name: `autoswitch  ${configValue(state, "autoswitch")}`,
          value: "autoswitch",
          description: "Configure automatic quota failover.",
        },
        {
          name: `ineligible  ${configValue(state, "ineligible")}`,
          value: "ineligible",
          description: "Allow or block activation of ineligible profiles.",
        },
        {
          name: `yolo        ${configValue(state, "yolo")}`,
          value: "yolo",
          description: "Launch agy with permissions skipped.",
        },
      ],
      loop: true,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") return undefined;
    throw error;
  }
}

async function pickConfigValue(key: ConfigKey, current: string): Promise<string | undefined> {
  const choices = key === "autoswitch"
    ? ["all-providers", "provider-first", "off"]
    : key === "ineligible"
    ? ["allow", "block"]
    : ["on", "off"];
  try {
    return await select<string>({
      message: `Select value for ${key}`,
      choices: choices.map((value) => ({
        name: value,
        value,
        description: value === current ? "current" : undefined,
      })),
      loop: true,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") return undefined;
    throw error;
  }
}

async function setConfigValue(key: string, value: string): Promise<void> {
  if (!configKeys.has(key)) {
    throw new Error("Usage: agyx config set <autoswitch|ineligible|yolo> <value>");
  }
  if (key === "autoswitch") {
    const parsed = parseAutoSwitchMode(value);
    await setAutoSwitchMode(parsed);
    console.log(`Automatic quota failover: ${parsed}`);
    return;
  }
  if (key === "ineligible") {
    const allow = parseIneligibleMode(value);
    await setAllowIneligibleActivation(allow);
    console.log(`Ineligible activation: ${allow ? "allow" : "block"}`);
    return;
  }
  if (value !== "on" && value !== "off") throw new Error("Usage: agyx config yolo [on|off]");
  const state = await loadState();
  state.settings = state.settings ?? {};
  state.settings.yolo = value === "on";
  await saveState(state);
  console.log(`Yolo mode: ${value}`);
}

async function configure(args: string[]): Promise<number> {
  const state = await loadState();
  const subcommand = args.shift();
  if (!subcommand || subcommand === "list") {
    if (!subcommand && process.stdin.isTTY && process.stdout.isTTY) {
      const key = await pickConfigKey(state);
      if (!key) return 0;
      const value = await pickConfigValue(key, configValue(state, key));
      if (!value) return 0;
      await setConfigValue(key, value);
      return 0;
    }
    if (args.length) throw new Error("Usage: agyx config list");
    printConfig(state);
    return 0;
  }
  if (subcommand === "get") {
    const key = takeOptionalName(args, "agyx config get <autoswitch|ineligible|yolo>") as ConfigKey | undefined;
    if (!key || !configKeys.has(key)) throw new Error("Usage: agyx config get <autoswitch|ineligible|yolo>");
    console.log(configValue(state, key));
    return 0;
  }
  if (subcommand === "set") {
    const key = args.shift();
    const value = args.shift();
    if (!key || !value || args.length) {
      throw new Error("Usage: agyx config set <autoswitch|ineligible|yolo> <value>");
    }
    await setConfigValue(key, value);
    return 0;
  }
  if (!configKeys.has(subcommand)) {
    throw new Error("Usage: agyx config [list|get|set|autoswitch|ineligible|yolo]");
  }
  const key = subcommand as ConfigKey;
  const value = args.shift();
  if (args.length) throw new Error(`Usage: agyx config ${key} [value]`);
  if (!value) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(configValue(state, key));
      return 0;
    }
    const selected = await pickConfigValue(key, configValue(state, key));
    if (!selected) return 0;
    await setConfigValue(key, selected);
    return 0;
  }
  await setConfigValue(key, value);
  return 0;
}

async function removeProfile(name: string): Promise<void> {
  await withAuthSwitchLock(async () => {
    validateProfileName(name);
    await keychain.deleteProfile(name);
    const state = await loadState();
    state.profiles = state.profiles.filter((profile) => profile.name !== name);
    if (state.activeProfile === name) state.activeProfile = undefined;
    await saveState(state);
  });
}

async function renameProfile(oldNameInput: string, newNameInput: string): Promise<boolean> {
  return await withAuthSwitchLock(async () => {
    const oldName = validateProfileName(oldNameInput);
    const newName = validateProfileName(newNameInput.trim());
    if (oldName === newName) return false;

    const state = await loadState();
    const profile = state.profiles.find((entry) => entry.name === oldName);
    if (!profile) throw new Error(`Profile not found: ${oldName}`);
    if (state.profiles.some((entry) =>
      entry !== profile
      && (entry.name === newName || entry.previousNames?.includes(newName))
    )) {
      throw new Error(`Profile already exists: ${newName}`);
    }

    const credential = await keychain.readProfile(oldName);
    await keychain.writeProfile(newName, credential);
    const previousNames = new Set(profile.previousNames ?? []);
    previousNames.delete(newName);
    previousNames.add(oldName);
    profile.previousNames = [...previousNames].sort();
    profile.name = newName;
    profile.updatedAt = new Date().toISOString();
    if (state.activeProfile === oldName) state.activeProfile = newName;
    state.profiles.sort((left, right) => left.name.localeCompare(right.name));
    await saveState(state);
    await keychain.deleteProfile(oldName);
    return true;
  });
}

async function confirmAndRemoveProfile(name: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Refusing to delete without an interactive confirmation.");
  }
  const confirmed = await confirmAction(`Delete profile '${name}'?`, false);
  if (!confirmed) return false;
  await removeProfile(name);
  return true;
}

async function promptAndRenameProfile(name: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Refusing to rename without an interactive terminal.");
  }
  const nextName = (await promptText(`Rename profile '${name}' to`, name))?.trim();
  if (!nextName || nextName === name) return undefined;
  const renamed = await renameProfile(name, nextName);
  return renamed ? nextName : undefined;
}

async function browseProfiles(mode: "list" | "use"): Promise<string | undefined> {
  const quotaScopes = await activeQuotaScopes();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (mode === "list") {
      printProfileTable(await loadState(), quotaScopes);
      return undefined;
    }
    throw new Error("Usage: agyx use <name> or run 'agyx use' in an interactive terminal.");
  }

  let notice: string | undefined;
  while (true) {
    const state = await loadState();
    if (mode === "use") {
      const decision = decideProfileUse(state, quotaScopes);
      if (decision.type === "empty") throw new Error(decision.message);
    }
    const action = await pickProfileAction(state, mode, notice, quotaScopes);
    notice = undefined;
    if (action.type === "exit") return undefined;
    if (action.type === "select") return action.name;
    if (action.type === "delete") {
      if (await confirmAndRemoveProfile(action.name)) {
        notice = `Removed profile '${action.name}'.`;
      }
    } else if (action.type === "rename") {
      const nextName = await promptAndRenameProfile(action.name);
      if (nextName) {
        notice = `Renamed profile '${action.name}' to '${nextName}'.`;
      }
    }
  }
}

async function printSessionRecords(): Promise<void> {
  const records = await sessionRecords();
  if (!records.length) console.log("No supervised agy sessions.");
  for (const record of records) {
    console.log(
      `${record.id}  pid=${record.pid} child=${record.childPid ?? "-"}`
      + `  ${record.paused ? "paused" : "running"}  cwd=${record.cwd}`
      + (record.conversationId ? `  conversation=${record.conversationId}` : ""),
    );
  }
}

async function printStatus(): Promise<void> {
  const state = await loadState();
  const sessions = await sessionRecords();
  console.log(`active profile: ${state.activeProfile ?? "unmanaged"}`);
  console.log(`autoswitch: ${effectiveAutoSwitchMode(state)}`);
  console.log(`ineligible: ${effectiveAllowIneligibleActivation(state) ? "allow" : "block"}`);
  console.log(`yolo: ${effectiveYoloMode(state) ? "on" : "off"}`);
  console.log(`real agy: ${await findRealAgy().catch(() => "(not found)")}`);
  console.log(`shell integration file: ${shellIntegrationPath()}`);
  console.log(`shell integration installed: ${await shellIntegrationInstalled() ? "yes" : "no"}`);
  console.log(`supervised sessions: ${sessions.length}`);
}

async function handleLoginCommand(args: string[]): Promise<number> {
  const email = takeOption(args, "--email");
  const noResume = takeFlag(args, "--no-resume");
  const name = takeOptionalName(args, "agyx login [name] [--email EMAIL] [--no-resume]");
  await loginProfile(name, email, !noResume);
  return 0;
}

async function handleImportCurrentCommand(args: string[], command = "import-current"): Promise<number> {
  const email = takeOption(args, "--email");
  const name = takeOptionalName(args, `agyx ${command} [name] [--email EMAIL]`);
  const result = await saveCurrent(name, email);
  console.log(
    `Saved and activated profile '${result.name}'.`
    + (result.email ? ` (${result.email})` : ""),
  );
  return 0;
}

async function handleUseCommand(args: string[]): Promise<number> {
  const name = args.shift();
  if (args.length) throw new Error("Usage: agyx use [name]");
  const selected = name ?? await browseProfiles("use");
  if (!selected) return 0;
  const result = await switchProfile(selected);
  printSwitchResult(result);
  return 0;
}

async function handleScanCommand(args: string[]): Promise<number> {
  const asJson = takeFlag(args, "--json");
  const record = takeFlag(args, "--record");
  if (args.length) throw new Error("Usage: agyx scan [--json] [--record]");
  const result = await runUsageProbe({ record });
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else printUsageScanResult(result);
  return result.ok ? 0 : 1;
}

async function handleListCommand(args: string[]): Promise<number> {
  const verify = takeFlag(args, "--verify");
  if (args.length) throw new Error("Usage: agyx list [--verify]");
  const state = verify ? await verifyAllProfiles() : await loadState();
  if (process.stdin.isTTY && process.stdout.isTTY) {
    let notice: string | undefined;
    const quotaScopes = await activeQuotaScopes();
    while (true) {
      const action = await pickProfileAction(await loadState(), "list", notice, quotaScopes);
      notice = undefined;
      if (action.type === "exit") break;
      if (action.type === "delete") {
        if (await confirmAndRemoveProfile(action.name)) {
          notice = `Removed profile '${action.name}'.`;
        }
      } else if (action.type === "rename") {
        const nextName = await promptAndRenameProfile(action.name);
        if (nextName) {
          notice = `Renamed profile '${action.name}' to '${nextName}'.`;
        }
      }
    }
  } else {
    printProfileTable(state, await activeQuotaScopes());
  }
  return 0;
}

async function runWrapperCommand(command: string, args: string[]): Promise<number> {
  switch (command) {
    case "login":
      return await handleLoginCommand(args);
    case "import-current":
    case "save":
      return await handleImportCurrentCommand(args, command);
    case "use":
      return await handleUseCommand(args);
    case "next": {
      const result = await switchToNextProfile();
      printSwitchResult(result);
      return 0;
    }
    case "scan":
      return await handleScanCommand(args);
    case "config":
      return await configure(args);
    case "autoswitch": {
      const mode = args.shift();
      if (args.length) throw new Error("Usage: agyx autoswitch [off|provider-first|all-providers]");
      if (!mode) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.log(effectiveAutoSwitchMode(await loadState()));
          return 0;
        }
        const selected = await pickAutoSwitchMode(effectiveAutoSwitchMode(await loadState()));
        if (!selected) return 0;
        await setAutoSwitchMode(selected);
        console.log(`Automatic quota failover: ${selected}`);
        return 0;
      }
      const parsed = parseAutoSwitchMode(mode);
      await setAutoSwitchMode(parsed);
      console.log(`Automatic quota failover: ${parsed}`);
      return 0;
    }
    case "ineligible": {
      const mode = args.shift();
      if (args.length) throw new Error("Usage: agyx ineligible [allow|block]");
      if (!mode) {
        console.log(effectiveAllowIneligibleActivation(await loadState()) ? "allow" : "block");
        return 0;
      }
      const allow = parseIneligibleMode(mode);
      await setAllowIneligibleActivation(allow);
      console.log(`Ineligible activation: ${allow ? "allow" : "block"}`);
      return 0;
    }
    case "yolo": {
      const value = args.shift();
      if (args.length) throw new Error("Usage: agyx yolo [on|off]");
      if (!value) {
        const current = effectiveYoloMode(await loadState());
        console.log(`Yolo mode: ${current ? "on" : "off"}`);
        return 0;
      }
      await setConfigValue("yolo", value);
      return 0;
    }
    case "list":
      return await handleListCommand(args);
    case "current":
      console.log((await loadState()).activeProfile ?? "unmanaged");
      return 0;
    case "status":
      await printStatus();
      return 0;
    case "sessions":
      await printSessionRecords();
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
    case "rename": {
      const oldName = args.shift();
      const newName = args.shift();
      if (!oldName || !newName || args.length) {
        throw new Error("Usage: agyx rename <old> <new>");
      }
      const renamed = await renameProfile(oldName, newName);
      console.log(renamed
        ? `Renamed profile '${oldName}' to '${newName}'.`
        : `Profile '${oldName}' is already named '${newName}'.`);
      return 0;
    }
    case "remove": {
      const name = args.shift();
      if (!name || args.length) throw new Error("Usage: agyx remove <name>");
      await confirmAndRemoveProfile(name);
      return 0;
    }
    default:
      throw new Error(`Unknown wrapper command: ${command}\n\n${wrapperHelp}`);
  }
}

async function printCombinedHelp(): Promise<void> {
  await spawnInherited(await findRealAgy(), ["--help"]);
  console.log("");
  console.log(wrapperHelp);
}

async function dispatchAgy(args: string[]): Promise<number> {
  if (args[0] === "--") args.shift();
  if (args[0] === "--native") return await spawnInherited(await findRealAgy(), args.slice(1));
  if (args[0] === "login") return await handleLoginCommand(args.slice(1));
  if (args[0] === "x") {
    args.shift();
    const command = args.shift();
    if (!command || ["help", "-h", "--help"].includes(command)) {
      console.log(wrapperHelp);
      return 0;
    }
    return await runWrapperCommand(command, args);
  }
  if (!args.length || ["help", "-h", "--help"].includes(args[0]!)) {
    await printCombinedHelp();
    return 0;
  }
  return await runNativeSupervisor(args);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(help);
    return 0;
  }
  await maybeRunOnboarding(command);

  switch (command) {
    case "install": {
      const path = await installShellIntegration();
      console.log(`Installed agy shell function in ${path}`);
      console.log("This does not change the current terminal automatically.");
      console.log("Open a new terminal, or run:");
      console.log(`  source ${path}`);
      console.log("For this terminal only, you can also run:");
      console.log('  eval "$(agyx shell-init)"');
      console.log("Verify with:");
      console.log("  type agy");
      return 0;
    }
    case "shell-init":
      console.log(shellInit());
      return 0;
    case "dispatch":
      return await dispatchAgy(args);
    case "x": {
      const wrapperCommand = args.shift();
      if (!wrapperCommand || ["help", "-h", "--help"].includes(wrapperCommand)) {
        console.log(wrapperHelp);
        return 0;
      }
      return await runWrapperCommand(wrapperCommand, args);
    }
    case "session":
      if (args[0] === "--") args.shift();
      return await runNativeSupervisor(args);
    case "save": {
      return await handleImportCurrentCommand(args, "save");
    }
    case "import-current":
      return await handleImportCurrentCommand(args);
    case "login": {
      return await handleLoginCommand(args);
    }
    case "use": {
      return await handleUseCommand(args);
    }
    case "next": {
      const result = await switchToNextProfile();
      printSwitchResult(result);
      return 0;
    }
    case "scan":
      return await handleScanCommand(args);
    case "autoswitch": {
      const mode = args.shift();
      if (args.length) throw new Error("Usage: agyx autoswitch [off|provider-first|all-providers]");
      if (!mode) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.log(effectiveAutoSwitchMode(await loadState()));
          return 0;
        }
        const selected = await pickAutoSwitchMode(effectiveAutoSwitchMode(await loadState()));
        if (!selected) return 0;
        await setAutoSwitchMode(selected);
        console.log(`Automatic quota failover: ${selected}`);
        return 0;
      }
      const parsed = parseAutoSwitchMode(mode);
      await setAutoSwitchMode(parsed);
      console.log(`Automatic quota failover: ${parsed}`);
      return 0;
    }
    case "ineligible": {
      const mode = args.shift();
      if (args.length) throw new Error("Usage: agyx ineligible [allow|block]");
      if (!mode) {
        console.log(effectiveAllowIneligibleActivation(await loadState()) ? "allow" : "block");
        return 0;
      }
      const allow = parseIneligibleMode(mode);
      await setAllowIneligibleActivation(allow);
      console.log(`Ineligible activation: ${allow ? "allow" : "block"}`);
      return 0;
    }
    case "yolo": {
      const value = args.shift();
      if (args.length) throw new Error("Usage: agyx yolo [on|off]");
      if (!value) {
        const current = effectiveYoloMode(await loadState());
        console.log(`Yolo mode: ${current ? "on" : "off"}`);
        return 0;
      }
      if (value !== "on" && value !== "off") throw new Error("Usage: agyx yolo [on|off]");
      const state = await loadState();
      state.settings = state.settings ?? {};
      state.settings.yolo = value === "on";
      await saveState(state);
      console.log(`Yolo mode: ${value}`);
      return 0;
    }
    case "list": {
      return await handleListCommand(args);
    }
    case "current":
      console.log((await loadState()).activeProfile ?? "unmanaged");
      return 0;
    case "status": {
      await printStatus();
      return 0;
    }
    case "sessions":
      await printSessionRecords();
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
    case "rename": {
      const oldName = args.shift();
      const newName = args.shift();
      if (!oldName || !newName || args.length) {
        throw new Error("Usage: agyx rename <old> <new>");
      }
      const renamed = await renameProfile(oldName, newName);
      console.log(renamed
        ? `Renamed profile '${oldName}' to '${newName}'.`
        : `Profile '${oldName}' is already named '${newName}'.`);
      return 0;
    }
    case "remove": {
      const name = args.shift();
      if (!name || args.length) throw new Error("Usage: agyx remove <name>");
      await confirmAndRemoveProfile(name);
      return 0;
    }
    case "doctor": {
      const state = await loadState();
      const sessions = await sessionRecords();
      console.log(`agy: ${await findRealAgy()}`);
      console.log(`platform: ${process.platform}`);
      console.log(`shell integration file: ${shellIntegrationPath()}`);
      console.log(`shell integration installed: ${await shellIntegrationInstalled() ? "yes" : "no"}`);
      console.log("current shell check: run `type agy` in your terminal; it should report a shell function");
      console.log(`profiles: ${state.profiles.length}`);
      console.log(`active profile: ${state.activeProfile ?? "unmanaged"}`);
      console.log(`auto switch: ${effectiveAutoSwitchMode(state)}`);
      console.log(`ineligible activation: ${effectiveAllowIneligibleActivation(state) ? "allow" : "block"}`);
      console.log(`supervised sessions: ${sessions.length}`);
      return 0;
    }
    case "config":
      return await configure(args);
    case "_activate":
      await activateProfile(args[0] ?? "");
      return 0;
    case "_auto-next":
      console.log(JSON.stringify(await autoSwitchAfterQuotaAction(parseQuotaScope(args[0]))));
      return 0;
    case "_supervisor-launch-args": {
      const payload = JSON.parse(args[0] ?? "{}") as {
        args?: string[];
        conversationId?: string;
        logPath?: string;
      };
      if (!payload.logPath) throw new Error("Usage: agyx _supervisor-launch-args <json>");
      console.log(JSON.stringify({
        argv: buildAgyLaunchArgs(payload.args ?? [], {
          conversationId: payload.conversationId,
          logPath: payload.logPath,
          state: await loadState(),
        }),
      }));
      return 0;
    }
    case "_usage-probe": {
      const payload = JSON.parse(args[0] ?? "{}") as {
        profileName?: string;
        realAgy?: string;
        cwd?: string;
      };
      console.log(JSON.stringify(await runUsageProbe(payload)));
      return 0;
    }
    case "_usage-transcript-aggregates": {
      const payload = JSON.parse(args[0] ?? "{}") as {
        text?: string;
        state?: UsageTranscriptState;
        now?: string;
      };
      const state = payload.state ?? createUsageTranscriptState();
      const now = payload.now ? new Date(payload.now) : new Date();
      const aggregates = parseUsageTranscriptAggregates(payload.text ?? "", now, state);
      console.log(JSON.stringify({ aggregates, state }));
      return 0;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${help}`);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`agyx: ${(error as Error).message}`);
    process.exitCode = 1;
  });
