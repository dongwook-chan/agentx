import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm } from "@inquirer/prompts";
import { ensureParent, saveCodexIntegration } from "./config.js";
import { findRealCodex } from "./processes.js";
import { probeCodexRemoteSupport } from "./remote.js";

const startMarker = "# >>> cdxx >>>";
const endMarker = "# <<< cdxx <<<";
const legacyStartMarker = "# >>> codexx >>>";
const legacyEndMarker = "# <<< codexx <<<";
const hookDescription = "cdxx session registration hooks";

export function codexHooksPath() {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "hooks.json");
}

export function codexHookCommand() {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(import.meta.resolve("@dong-/agentx-supervisor/cli")))} codex-hook`;
}

function hookEntry(event, command) {
  return {
    matcher: event === "SessionStart" ? "startup|resume|clear|compact" : undefined,
    hooks: [{ type: "command", command, timeout: 2 }],
  };
}

function mergeHook(document, event, entry) {
  document.hooks = document.hooks ?? {};
  const entries = document.hooks[event] ?? [];
  const filtered = entries.filter((candidate) =>
    !candidate?.hooks?.some((hook) => String(hook?.command ?? "").includes(" codex-hook"))
  );
  document.hooks[event] = [...filtered, entry];
}

export async function installCodexHooks() {
  const path = codexHooksPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let document = {};
  try { document = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  document.description = document.description ?? hookDescription;
  const command = codexHookCommand();
  mergeHook(document, "SessionStart", hookEntry("SessionStart", command));
  mergeHook(document, "UserPromptSubmit", hookEntry("UserPromptSubmit", command));
  mergeHook(document, "Stop", hookEntry("Stop", command));
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export async function removeCodexHooks() {
  const path = codexHooksPath();
  let document;
  try { document = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return path;
    throw error;
  }
  document.hooks = document.hooks ?? {};
  for (const [event, entries] of Object.entries(document.hooks)) {
    const filtered = entries.filter((candidate) =>
      !candidate?.hooks?.some((hook) => String(hook?.command ?? "").includes(" codex-hook"))
    );
    if (filtered.length) document.hooks[event] = filtered;
    else delete document.hooks[event];
  }
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function codexHooksInstalled() {
  try {
    const document = JSON.parse(await readFile(codexHooksPath(), "utf8"));
    return Object.values(document.hooks ?? {}).some((entries) =>
      entries.some((candidate) =>
        candidate?.hooks?.some((hook) => String(hook?.command ?? "").includes(" codex-hook"))
      )
    );
  } catch {
    return false;
  }
}

export async function configureCodexIntegration(realCodex, options = {}) {
  const saveIntegration = options.saveIntegration ?? saveCodexIntegration;
  const capability = await (options.probeRemote ?? probeCodexRemoteSupport)(realCodex);
  if (capability.supported) {
    await removeCodexHooks();
    return await saveIntegration({
      mode: "remote",
      checkedAt: new Date().toISOString(),
      realCodexPath: realCodex,
    });
  }

  const prompt = options.confirmHookInstall ?? (async (message) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    return await confirm({ message, default: false });
  });
  const accepted = await prompt([
    capability.reason,
    "Agentx can install Codex lifecycle hooks as a fallback.",
    "This modifies ~/.codex/hooks.json and runs an agentx command on SessionStart, UserPromptSubmit, and Stop.",
    "Install the Codex hooks?",
  ].join("\n"));
  if (accepted) {
    await installCodexHooks();
    return await saveIntegration({
      mode: "hooks",
      checkedAt: new Date().toISOString(),
      realCodexPath: realCodex,
      reason: capability.reason,
    });
  }
  await removeCodexHooks();
  return await saveIntegration({
    mode: "disabled",
    checkedAt: new Date().toISOString(),
    realCodexPath: realCodex,
    reason: capability.reason,
  });
}

export function shellIntegrationPath() {
  const shellName = process.env.SHELL?.split("/").at(-1) ?? "zsh";
  return shellName === "bash" ? join(homedir(), ".bashrc") : join(homedir(), ".zshrc");
}

export function shellInit() {
  return [
    "codex() {",
    "  command cdxx dispatch -- \"$@\"",
    "}",
  ].join("\n");
}

async function writeShellIntegration(enabled) {
  const rcPath = shellIntegrationPath();
  await ensureParent(rcPath);
  let content = "";
  let existed = true;
  try {
    content = await readFile(rcPath, "utf8");
  } catch {
    existed = false;
  }
  const block = `${startMarker}\n${shellInit()}\n${endMarker}`;
  const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, "m");
  const legacyPattern = new RegExp(`${legacyStartMarker}[\\s\\S]*?${legacyEndMarker}`, "m");
  let next = content;
  if (!enabled) {
    next = next.replace(legacyPattern, "").replace(pattern, "").replace(/\n{3,}/g, "\n\n");
  } else if (legacyPattern.test(next)) next = next.replace(legacyPattern, block);
  else if (pattern.test(next)) next = next.replace(pattern, block);
  else {
    const trimmed = next.trimEnd();
    next = `${trimmed ? `${trimmed}\n\n` : ""}${block}\n`;
  }
  await writeFile(rcPath, next, { mode: 0o600 });
  if (!existed) await chmod(rcPath, 0o600).catch(() => undefined);
  return rcPath;
}

export async function installShellIntegration(options = {}) {
  const realCodex = await findRealCodex();
  const integration = await configureCodexIntegration(realCodex, options);
  const path = await writeShellIntegration(integration.mode !== "disabled");
  return { path, integration };
}
