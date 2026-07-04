import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearExpiredProfileQuota,
  markActiveProfile,
  profileNameFromIdentity as coreProfileNameFromIdentity,
  uniqueProfileName as coreUniqueProfileName,
  validateProfileName as coreValidateProfileName,
} from "@dong-/agentx-core";

export const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const defaultConfigDir = join(homedir(), ".config", "cdxx");
const legacyConfigDir = join(homedir(), ".config", "codexx");
export const configDir = process.env.CDXX_CONFIG_DIR
  ?? process.env.CODEXX_CONFIG_DIR
  ?? (existsSync(defaultConfigDir) || !existsSync(legacyConfigDir) ? defaultConfigDir : legacyConfigDir);
export const profilesDir = join(configDir, "profiles");
export const runtimeDir = join(configDir, "run");
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
  await ensureDir(runtimeDir);
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
  return coreValidateProfileName(input);
}

export function profileNameFromIdentity(identity) {
  return coreProfileNameFromIdentity(identity);
}

export function uniqueProfileName(baseName, state) {
  return coreUniqueProfileName(baseName, state);
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
  markActiveProfile(state, name, { incrementSelection: increment });
}

export function clearExpiredQuota(profile, now = new Date()) {
  clearExpiredProfileQuota(profile, now);
  if (!profile.quotaScopes) return;
  const exhausted = [];
  for (const quota of Object.values(profile.quotaScopes)) {
    if (!quota || quota.status !== "exhausted") continue;
    if (quota.resetAt && Date.parse(quota.resetAt) <= now.getTime()) {
      quota.status = "available";
      quota.resetAt = undefined;
      quota.reason = undefined;
    } else {
      exhausted.push(quota);
    }
  }
  if (exhausted.length) {
    const nextReset = exhausted
      .map((quota) => quota.resetAt)
      .filter(Boolean)
      .sort()[0];
    profile.quotaStatus = "exhausted";
    profile.quotaResetAt = nextReset;
    profile.lastQuotaReason = exhausted.find((quota) => quota.reason)?.reason ?? "quota exhausted";
  } else if (profile.quotaStatus === "exhausted") {
    profile.quotaStatus = "available";
    profile.quotaResetAt = undefined;
    profile.lastQuotaReason = undefined;
  }
}
