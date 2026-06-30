import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureParent } from "./config.js";
import { findRealCodex } from "./processes.js";

const startMarker = "# >>> cdxx >>>";
const endMarker = "# <<< cdxx <<<";
const legacyStartMarker = "# >>> codexx >>>";
const legacyEndMarker = "# <<< codexx <<<";

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
