import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { loadState, saveState } from "./config.js";

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isCdxxWrapper(path) {
  try {
    const content = await readFile(path, "utf8");
    return content.includes("cdxx session")
      || content.includes("cdxx dispatch")
      || content.includes("cdxx-supervisor");
  } catch {
    return false;
  }
}

export async function findRealCodex() {
  const override = process.env.CDXX_REAL_CODEX;
  if (override && await executable(override)) return resolve(override);

  const state = await loadState();
  if (
    state.realCodexPath
    && await executable(state.realCodexPath)
    && !await isCdxxWrapper(state.realCodexPath)
  ) {
    return state.realCodexPath;
  }

  const candidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    ...((process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, "codex"))),
  ];

  for (const candidate of [...new Set(candidates)]) {
    if (!await executable(candidate)) continue;
    if (await isCdxxWrapper(candidate)) continue;
    state.realCodexPath = candidate;
    await saveState(state);
    return candidate;
  }

  throw new Error("Could not find the real 'codex' executable. Set CDXX_REAL_CODEX.");
}

export function isInteractiveCodex(args) {
  const command = args.find((arg) => !arg.startsWith("-"));
  if (!command) return true;
  return ![
    "exec",
    "e",
    "review",
    "login",
    "logout",
    "mcp",
    "plugin",
    "doctor",
    "completion",
    "update",
  ].includes(command);
}
