import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearExpiredProfileQuota,
  markActiveProfile,
  profileNameFromIdentity,
  uniqueProfileName as coreUniqueProfileName,
  validateProfileName as coreValidateProfileName,
} from "@dong-/agentx-core";
import { QuotaScope } from "./quota.js";

export interface ScopedQuotaRecord {
  status: "exhausted";
  resetAt?: string;
  reason?: string;
  errorAt?: string;
  modelLabel?: string;
}

export type AutoSwitchMode = "off" | "provider-first" | "all-providers";

export const defaultAutoSwitchMode: AutoSwitchMode = "all-providers";

export function effectiveAutoSwitchMode(state: Pick<State, "settings">): AutoSwitchMode {
  return state.settings?.autoSwitchMode ?? defaultAutoSwitchMode;
}

export const defaultYoloMode = true;

export function effectiveYoloMode(state: Pick<State, "settings">): boolean {
  return state.settings?.yolo ?? defaultYoloMode;
}

export const defaultAllowIneligibleActivation = true;
const resetlessQuotaTtlMs = 24 * 60 * 60 * 1000;

export function effectiveAllowIneligibleActivation(state: Pick<State, "settings">): boolean {
  return state.settings?.allowIneligibleActivation ?? defaultAllowIneligibleActivation;
}

export interface ProfileRecord {
  name: string;
  previousNames?: string[];
  email?: string;
  createdAt: string;
  updatedAt: string;
  authenticatedAt?: string;
  lastActivatedAt?: string;
  lastRequestAt?: string;
  lastSuccessfulRequestAt?: string;
  lastQuotaErrorAt?: string;
  quotaResetAt?: string;
  quotaStatus?: "unknown" | "available" | "exhausted";
  lastQuotaReason?: string;
  quotaScopes?: Partial<Record<QuotaScope, ScopedQuotaRecord>>;
  credentialStatus?: "unknown" | "verified" | "mismatch" | "error";
  verifiedEmail?: string;
  credentialVerifiedAt?: string;
  credentialMismatchAt?: string;
  credentialError?: string;
  eligibilityStatus?: "unknown" | "eligible" | "ineligible";
  lastEligibilityErrorAt?: string;
  eligibilityReason?: string;
  selectionCount?: number;
  disabled?: boolean;
  priority?: number;
}

export interface State {
  version: 1;
  activeProfile?: string;
  realAgyPath?: string;
  settings?: {
    autoSwitchMode?: AutoSwitchMode;
    yolo?: boolean;
    allowIneligibleActivation?: boolean;
  };
  onboarding?: {
    shellIntegrationPromptedAt?: string;
    shellIntegrationInstalledAt?: string;
    githubStarPromptedAt?: string;
    githubStarredAt?: string;
  };
  profiles: ProfileRecord[];
}

export const configDir = process.env.AGYX_CONFIG_DIR
  ?? join(homedir(), ".config", "agyx");
export const runtimeDir = join(configDir, "run");
export const logDir = join(configDir, "logs");
export const statePath = join(configDir, "state.json");

export async function ensureDirectories(): Promise<void> {
  for (const directory of [configDir, runtimeDir, logDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

export async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, profiles: [] };
    }
    throw error;
  }
}

export async function saveState(state: State): Promise<void> {
  await ensureDirectories();
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
}

export async function upsertProfile(
  name: string,
  email: string | undefined,
  makeActive: boolean,
  countActivation = makeActive,
): Promise<void> {
  const state = await loadState();
  const now = new Date();
  const nowString = now.toISOString();
  const existing = state.profiles.find((profile) => profile.name === name);
  if (existing) {
    existing.email = email ?? existing.email;
    existing.authenticatedAt = nowString;
    existing.updatedAt = nowString;
    existing.credentialStatus = email ? "verified" : "unknown";
    existing.verifiedEmail = email ?? undefined;
    existing.credentialVerifiedAt = email ? nowString : undefined;
    existing.credentialMismatchAt = undefined;
    existing.credentialError = undefined;
    existing.eligibilityStatus = "unknown";
    existing.lastEligibilityErrorAt = undefined;
    existing.eligibilityReason = undefined;
    if (
      existing.quotaStatus === "exhausted"
      && existing.quotaResetAt
      && Date.parse(existing.quotaResetAt) <= now.getTime()
    ) {
      existing.quotaStatus = "available";
      existing.quotaResetAt = undefined;
      existing.lastQuotaReason = undefined;
    }
    clearExpiredScopedQuotas(existing, now);
  } else {
    state.profiles.push({
      name,
      email,
      createdAt: nowString,
      updatedAt: nowString,
      authenticatedAt: nowString,
      quotaStatus: "available",
      credentialStatus: email ? "verified" : "unknown",
      verifiedEmail: email,
      credentialVerifiedAt: email ? nowString : undefined,
      eligibilityStatus: "unknown",
      selectionCount: 0,
    });
  }
  state.profiles.sort((left, right) => left.name.localeCompare(right.name));
  if (makeActive) markProfileActivated(state, name, now, countActivation);
  await saveState(state);
}

export function markProfileActivated(
  state: State,
  name: string,
  now = new Date(),
  incrementSelection = true,
): void {
  const profile = markActiveProfile(state, name, { now, incrementSelection });
  clearExpiredScopedQuotas(profile, now);
}

export function markProfileRequest(
  state: State,
  name: string,
  now = new Date(),
): void {
  const profile = state.profiles.find((entry) =>
    entry.name === name || entry.previousNames?.includes(name)
  );
  if (!profile) return;
  const nowString = now.toISOString();
  profile.lastRequestAt = nowString;
  profile.lastSuccessfulRequestAt = nowString;
  profile.updatedAt = nowString;
  if (profile.quotaStatus !== "exhausted") profile.quotaStatus = "available";
  clearExpiredScopedQuotas(profile, now);
  profile.eligibilityStatus = "eligible";
  profile.eligibilityReason = undefined;
  profile.lastEligibilityErrorAt = undefined;
}

export function markProfileQuotaExhausted(
  state: State,
  name: string,
  event: { reason: string; resetAt?: string; scope?: QuotaScope; modelLabel?: string },
  now = new Date(),
): void {
  const profile = state.profiles.find((entry) =>
    entry.name === name || entry.previousNames?.includes(name)
  );
  if (!profile) return;
  const nowString = now.toISOString();
  profile.lastQuotaErrorAt = nowString;
  profile.lastQuotaReason = event.reason;
  const scope = event.scope ?? "unknown";
  profile.quotaScopes = profile.quotaScopes ?? {};
  profile.quotaScopes[scope] = {
    status: "exhausted",
    resetAt: event.resetAt,
    reason: event.reason,
    errorAt: nowString,
    modelLabel: event.modelLabel,
  };
  if (scope === "unknown") {
    profile.quotaStatus = "exhausted";
    profile.quotaResetAt = event.resetAt;
  }
  profile.updatedAt = nowString;
}

export function markProfileQuotaAvailable(
  state: State,
  name: string,
  scope: QuotaScope,
  now = new Date(),
): void {
  const profile = state.profiles.find((entry) =>
    entry.name === name || entry.previousNames?.includes(name)
  );
  if (!profile) return;
  if (scope === "unknown") {
    profile.quotaStatus = "available";
    profile.quotaResetAt = undefined;
    profile.lastQuotaReason = undefined;
    delete profile.quotaScopes?.unknown;
  } else {
    delete profile.quotaScopes?.[scope];
    delete profile.quotaScopes?.unknown;
  }
  if (profile.quotaScopes && !Object.keys(profile.quotaScopes).length) {
    delete profile.quotaScopes;
  }
  if (!profile.quotaScopes && profile.quotaStatus === "exhausted") {
    profile.quotaStatus = "available";
    profile.quotaResetAt = undefined;
    profile.lastQuotaReason = undefined;
  }
  profile.updatedAt = now.toISOString();
}

export function clearExpiredScopedQuotas(
  profile: ProfileRecord,
  now = new Date(),
): void {
  if (!profile.quotaScopes) return;
  for (const [scope, quota] of Object.entries(profile.quotaScopes) as Array<
    [QuotaScope, ScopedQuotaRecord]
  >) {
    if (quota.resetAt && Date.parse(quota.resetAt) <= now.getTime()) {
      delete profile.quotaScopes[scope];
    } else if (!quota.resetAt) {
      const checkedAt = quota.errorAt ?? profile.lastQuotaErrorAt ?? profile.updatedAt;
      const checkedMs = checkedAt ? Date.parse(checkedAt) : undefined;
      if (
        typeof checkedMs === "number"
        && Number.isFinite(checkedMs)
        && now.getTime() - checkedMs >= resetlessQuotaTtlMs
      ) {
        delete profile.quotaScopes[scope];
      }
    }
  }
  if (!Object.keys(profile.quotaScopes).length) delete profile.quotaScopes;
  if (!profile.quotaScopes && profile.quotaStatus === "exhausted" && !profile.quotaResetAt) {
    profile.quotaStatus = "available";
    profile.lastQuotaReason = undefined;
  }
}

export function markProfileCredentialVerified(
  state: State,
  name: string,
  actualEmail: string,
  now = new Date(),
): void {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) return;
  const nowString = now.toISOString();
  profile.email = profile.email ?? actualEmail;
  profile.credentialStatus = "verified";
  profile.verifiedEmail = actualEmail;
  profile.credentialVerifiedAt = nowString;
  profile.credentialMismatchAt = undefined;
  profile.credentialError = undefined;
  profile.updatedAt = nowString;
}

export function markProfileCredentialMismatch(
  state: State,
  name: string,
  actualEmail: string | undefined,
  expectedEmail: string | undefined,
  now = new Date(),
): void {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) return;
  const nowString = now.toISOString();
  profile.credentialStatus = actualEmail ? "mismatch" : "error";
  profile.verifiedEmail = actualEmail;
  profile.credentialMismatchAt = nowString;
  profile.credentialError = actualEmail
    ? `expected ${expectedEmail ?? "-"}, got ${actualEmail}`
    : "credential probe did not return an authenticated email";
  profile.updatedAt = nowString;
  if (state.activeProfile === name) {
    state.activeProfile = actualEmail
      ? state.profiles.find((entry) =>
        entry.name !== name
        && (entry.email === actualEmail || entry.verifiedEmail === actualEmail)
      )?.name
      : undefined;
  }
}

export function markProfileIneligible(
  state: State,
  name: string,
  event: { reason: string },
  now = new Date(),
): void {
  const profile = state.profiles.find((entry) =>
    entry.name === name || entry.previousNames?.includes(name)
  );
  if (!profile) return;
  const nowString = now.toISOString();
  profile.eligibilityStatus = "ineligible";
  profile.lastEligibilityErrorAt = nowString;
  profile.eligibilityReason = event.reason;
  profile.updatedAt = nowString;
}

export async function recordProfileQuotaExhausted(
  name: string,
  event: { reason: string; resetAt?: string; scope?: QuotaScope; modelLabel?: string },
): Promise<void> {
  const state = await loadState();
  markProfileQuotaExhausted(state, name, event);
  await saveState(state);
}

export async function recordProfileQuotaAvailable(
  name: string,
  scope: QuotaScope,
): Promise<void> {
  const state = await loadState();
  markProfileQuotaAvailable(state, name, scope);
  await saveState(state);
}

export async function recordProfileRequest(
  name: string,
  now = new Date(),
): Promise<void> {
  const state = await loadState();
  markProfileRequest(state, name, now);
  await saveState(state);
}

export async function recordProfileIneligible(
  name: string,
  event: { reason: string },
): Promise<void> {
  const state = await loadState();
  markProfileIneligible(state, name, event);
  await saveState(state);
}

export async function cleanupRuntimeFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

export function validateProfileName(name: string): string {
  return coreValidateProfileName(name);
}

export function profileNameFromEmail(email: string): string {
  return profileNameFromIdentity(email);
}

export function uniqueProfileName(baseName: string, state: State): string {
  return coreUniqueProfileName(baseName, state, {
    aliases: (profile) => profile.previousNames,
  });
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}
