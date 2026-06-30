import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const defaultConfigDir = join(homedir(), ".config", "cdxx");
const legacyConfigDir = join(homedir(), ".config", "codexx");
export const configDir = process.env.CDXX_CONFIG_DIR
  ?? process.env.CODEXX_CONFIG_DIR
  ?? (existsSync(defaultConfigDir) || !existsSync(legacyConfigDir) ? defaultConfigDir : legacyConfigDir);
export const profilesDir = join(configDir, "profiles");
export const statePath = join(configDir, "state.json");

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function ensureParent(path) {
  await ensureDir(dirname(path));
}

export async function ensureConfig() {
  await ensureDir(configDir);
  await ensureDir(profilesDir);
}

export function emptyState() {
  return {
    version: 1,
    activeProfile: undefined,
    realCodexPath: undefined,
    settings: {
      autoswitch: false,
      yolo: true,
    },
    profiles: [],
    sessions: {},
  };
}

export function effectiveYoloMode(state) {
  return state.settings?.yolo ?? true;
}

export async function loadState() {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return {
      ...emptyState(),
      ...state,
      settings: { ...emptyState().settings, ...(state.settings ?? {}) },
      profiles: state.profiles ?? [],
      sessions: state.sessions ?? {},
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(state) {
  await ensureConfig();
  const temp = `${statePath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, statePath);
}

export function validateProfileName(input) {
  const name = String(input ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error("Profile names must be 1-64 chars: letters, numbers, dot, underscore, dash.");
  }
  return name;
}

export function profileNameFromIdentity(identity) {
  const source = String(identity ?? "").split("@")[0] ?? "";
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[._-]{2,}/g, "-")
    .slice(0, 64);
  return validateProfileName(normalized || "account");
}

export function uniqueProfileName(baseName, state) {
  const base = validateProfileName(baseName);
  const names = new Set(state.profiles.map((profile) => profile.name));
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base.slice(0, Math.max(1, 64 - String(suffix).length - 1))}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused profile name for '${base}'.`);
}

export function getProfile(state, name) {
  return state.profiles.find((profile) => profile.name === name);
}

export function upsertProfile(state, name, patch = {}) {
  const existing = getProfile(state, name);
  const now = nowIso();
  if (existing) {
    Object.assign(existing, patch, { updatedAt: now });
    return existing;
  }
  const profile = {
    name,
    createdAt: now,
    updatedAt: now,
    quotaStatus: "unknown",
    selectionCount: 0,
    disabled: false,
    ...patch,
  };
  state.profiles.push(profile);
  state.profiles.sort((left, right) => left.name.localeCompare(right.name));
  return profile;
}

export function markActive(state, name, increment = true) {
  const profile = getProfile(state, name);
  if (!profile) throw new Error(`Profile not found: ${name}`);
  const now = nowIso();
  state.activeProfile = name;
  profile.lastActivatedAt = now;
  profile.updatedAt = now;
  if (increment) profile.selectionCount = (profile.selectionCount ?? 0) + 1;
  clearExpiredQuota(profile);
}

export function clearExpiredQuota(profile, now = new Date()) {
  if (profile.quotaStatus === "exhausted" && profile.quotaResetAt) {
    if (Date.parse(profile.quotaResetAt) <= now.getTime()) {
      profile.quotaStatus = "available";
      profile.quotaResetAt = undefined;
      profile.lastQuotaReason = undefined;
    }
  }
}
