import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexHome, ensureConfig, ensureDir, loadState, markActive, profileNameFromIdentity, profilesDir, saveState, uniqueProfileName, upsertProfile, validateProfileName } from "./config.js";
import { withAuthSwitchLock } from "./lock.js";

export const activeAuthPath = join(codexHome, "auth.json");

export function profileAuthPath(name) {
  return join(profilesDir, validateProfileName(name), "auth.json");
}

function base64UrlJson(segment) {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

export function summarizeAuthJson(auth) {
  const summary = {
    authMode: auth.auth_mode,
    accountId: auth.tokens?.account_id,
    email: undefined,
    hasApiKey: Boolean(auth.OPENAI_API_KEY),
    hasRefreshToken: Boolean(auth.tokens?.refresh_token),
  };
  const idToken = auth.tokens?.id_token;
  if (typeof idToken === "string" && idToken.split(".").length >= 2) {
    try {
      const payload = base64UrlJson(idToken.split(".")[1]);
      summary.email = payload.email ?? payload["https://api.openai.com/email"];
    } catch {
      // Ignore unparsable token payloads; the raw token is never logged.
    }
  }
  return summary;
}

export async function readActiveAuthSummary() {
  const content = await readFile(activeAuthPath, "utf8");
  return summarizeAuthJson(JSON.parse(content));
}

export function isValidCodexAuth(raw) {
  try {
    const summary = summarizeAuthJson(JSON.parse(String(raw)));
    return Boolean(summary.hasRefreshToken || summary.hasApiKey);
  } catch {
    return false;
  }
}

async function readActiveAuthIfValid() {
  const raw = await readFile(activeAuthPath, "utf8");
  if (!isValidCodexAuth(raw)) throw new Error(`Active Codex auth is invalid at ${activeAuthPath}.`);
  return raw;
}

async function restoreActiveAuth(raw) {
  await ensureDir(codexHome);
  await writeFile(activeAuthPath, raw, { mode: 0o600 });
  await chmod(activeAuthPath, 0o600).catch(() => undefined);
}

export async function guardedLoginProfile(inputName, runLogin, options = {}) {
  return await withAuthSwitchLock(async () => {
    const stateBefore = await loadState();
    const previousActiveProfile = stateBefore.activeProfile;
    const previousAuth = await readActiveAuthIfValid().catch(() => undefined);
    const backupDir = await mkdtemp(join(tmpdir(), "cdxx-login-"));
    const backupPath = join(backupDir, "auth.json");
    if (previousAuth) await writeFile(backupPath, previousAuth, { mode: 0o600 });
    try {
      const code = await runLogin();
      const nextAuth = options.candidateAuthPath
        ? await readFile(options.candidateAuthPath, "utf8").then((raw) =>
          isValidCodexAuth(raw) ? raw : undefined
        ).catch(() => undefined)
        : await readActiveAuthIfValid().catch(() => undefined);
      if (code !== 0 || !nextAuth) {
        if (previousAuth) await restoreActiveAuth(previousAuth);
        await saveState(stateBefore);
        console.error(
          previousActiveProfile
            ? `Login was cancelled or did not produce a valid Codex credential. Restored previous active profile '${previousActiveProfile}'.`
            : "Login was cancelled or did not produce a valid Codex credential.",
        );
        return code === 0 ? 1 : code;
      }
      if (options.candidateAuthPath) await restoreActiveAuth(nextAuth);
      const result = await saveCurrentProfileUnlocked(inputName);
      console.log(`Saved and activated '${result.name}'${result.email ? ` (${result.email})` : ""}.`);
      return 0;
    } finally {
      await rm(backupDir, { recursive: true, force: true });
    }
  });
}

export async function saveCurrentProfile(inputName) {
  return await withAuthSwitchLock(async () => {
    return await saveCurrentProfileUnlocked(inputName);
  });
}

async function saveCurrentProfileUnlocked(inputName) {
  await stat(activeAuthPath).catch(() => {
    throw new Error(`No active Codex auth file found at ${activeAuthPath}. Run 'codex login' first.`);
  });
  await ensureConfig();
  const raw = await readFile(activeAuthPath, "utf8");
  const summary = summarizeAuthJson(JSON.parse(raw));
  const state = await loadState();
  const name = inputName
    ? validateProfileName(inputName)
    : resolveProfileName(state, summary);
  const profileDir = join(profilesDir, name);
  await ensureDir(profileDir);
  const target = profileAuthPath(name);
  await writeFile(target, raw, { mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);

  upsertProfile(state, name, {
    email: summary.email,
    accountId: summary.accountId,
    authMode: summary.authMode,
    hasApiKey: summary.hasApiKey,
    hasRefreshToken: summary.hasRefreshToken,
    credentialStatus: "saved",
    quotaStatus: "available",
  });
  markActive(state, name);
  await saveState(state);
  return { name, ...summary };
}

function resolveProfileName(state, summary) {
  const identity = summary.email ?? summary.accountId;
  if (!identity) {
    throw new Error("Usage: cdxx save [name]. Profile name could not be inferred because no active Codex account identity was found.");
  }
  const existing = state.profiles.find((profile) =>
    profile.email === summary.email
    || profile.accountId === summary.accountId
  );
  if (existing) return existing.name;
  return uniqueProfileName(profileNameFromIdentity(identity), state);
}

export async function refreshActiveProfileCredential() {
  return await withAuthSwitchLock(async () => {
    const state = await loadState();
    if (!state.activeProfile) return undefined;
    const active = state.profiles.find((profile) => profile.name === state.activeProfile);
    if (!active) return undefined;
    await stat(activeAuthPath).catch(() => undefined);
    const raw = await readFile(activeAuthPath, "utf8").catch(() => undefined);
    if (!raw) return undefined;
    const target = profileAuthPath(active.name);
    await ensureDir(join(profilesDir, active.name));
    await writeFile(target, raw, { mode: 0o600 });
    await chmod(target, 0o600).catch(() => undefined);
    const summary = summarizeAuthJson(JSON.parse(raw));
    Object.assign(active, {
      email: summary.email ?? active.email,
      accountId: summary.accountId ?? active.accountId,
      authMode: summary.authMode ?? active.authMode,
      hasApiKey: summary.hasApiKey,
      hasRefreshToken: summary.hasRefreshToken,
      credentialStatus: "saved",
      updatedAt: new Date().toISOString(),
    });
    await saveState(state);
    return { name: active.name, ...summary };
  });
}

export async function useProfile(inputName) {
  return await withAuthSwitchLock(async () => {
    const name = validateProfileName(inputName);
    const source = profileAuthPath(name);
    await stat(source).catch(() => {
      throw new Error(`No saved credential for profile '${name}'. Run 'cdxx save ${name}' first.`);
    });
    await ensureDir(codexHome);
    await copyFile(source, activeAuthPath);
    await chmod(activeAuthPath, 0o600).catch(() => undefined);

    const state = await loadState();
    markActive(state, name);
    const profile = state.profiles.find((entry) => entry.name === name);
    if (profile) profile.credentialStatus = "active";
    await saveState(state);
    return profile ?? { name };
  });
}

export async function removeProfile(inputName) {
  return await withAuthSwitchLock(async () => {
    const name = validateProfileName(inputName);
    await rm(join(profilesDir, name), { recursive: true, force: true });
    const state = await loadState();
    state.profiles = state.profiles.filter((profile) => profile.name !== name);
    if (state.activeProfile === name) state.activeProfile = undefined;
    await saveState(state);
  });
}
