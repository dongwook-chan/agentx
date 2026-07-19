import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureParent } from "./config.js";
import { findRealCodex } from "./processes.js";

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

export async function installShellIntegration() {
  await findRealCodex();
  await installCodexHooks();
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
  if (legacyPattern.test(next)) next = next.replace(legacyPattern, block);
  else if (pattern.test(next)) next = next.replace(pattern, block);
  else {
    const trimmed = next.trimEnd();
    next = `${trimmed ? `${trimmed}\n\n` : ""}${block}\n`;
  }
  await writeFile(rcPath, next, { mode: 0o600 });
  if (!existed) await chmod(rcPath, 0o600).catch(() => undefined);
  return rcPath;
}
