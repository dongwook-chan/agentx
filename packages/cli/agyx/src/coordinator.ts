import { spawn } from "node:child_process";
import {
  agentCliManifests,
  appendAgentEvent,
  AuthSwitchTransactionOptions,
  AutoSwitchAction,
  decideExplicitProfileUse,
  decideLiveQuotaFailover,
  decideObservedProfileFailover,
  enqueuePendingQuotaContinuation,
  pauseAllSessions,
  PendingQuotaContinuation,
  persistCurrentCredential,
  quotaSwitchingNotice,
  removeCompletedQuotaContinuations,
  resumeAllSessions,
  runAuthSwitchTransaction,
  SessionControlAdapter,
} from "@dong-/agentx-core";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import {
  ensureDirectories,
  eventLogPath,
  loadState,
  logDir,
  markProfileActivated,
  markProfileCredentialMismatch,
  markProfileCredentialVerified,
  profileNameFromEmail,
  runtimeDir,
  saveState,
  State,
  upsertProfile,
  uniqueProfileName,
  validateProfileName,
  AutoSwitchMode,
  effectiveAutoSwitchMode,
  effectiveAllowIneligibleActivation,
} from "./config.js";
import { keychain } from "./keychain.js";
import { detectCredentialEmail, isValidAgyCredential } from "./google_auth.js";
import {
  findRealAgy,
  runningAgy,
  stopProcesses,
} from "./processes.js";
import { canonicalQuotaScope, QuotaScope } from "./quota.js";
import {
  effectiveProfileStatus,
  isProfileSelectable,
  selectAutoSwitchProfile,
  selectNextProfile,
  shouldAutoSwitchAfterQuota,
} from "./selection.js";
import { SessionRecord } from "./session_record.js";
import { supervisorRequest } from "@dong-/agentx-supervisor";

interface SessionReply {
  ok: boolean;
  error?: string;
  record?: SessionRecord;
}

const authSwitchLockPath = join(runtimeDir, "auth-switch.lock");
let authSwitchLockDepth = 0;

async function logSwitchEvent(event: { event: string } & Record<string, unknown>): Promise<void> {
  await appendAgentEvent(eventLogPath, { product: "agyx", ...event }).catch(() => undefined);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJSONPrefix<T>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;

    for (let index = 0; index < content.length; index += 1) {
      const character = content[index]!;
      if (!started) {
        if (/\s/.test(character)) continue;
        if (character !== "{") throw error;
        started = true;
        depth = 1;
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = inString;
        continue;
      }
      if (character === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth === 0) {
        return JSON.parse(content.slice(0, index + 1)) as T;
      }
    }
    throw error;
  }
}

async function writeRuntimeRecord(path: string, record: SessionRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function send(socketPath: string, command: string, payload: Record<string, unknown> = {}): Promise<SessionReply> {
  return await new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath);
    let input = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify({ command, ...payload })}\n`));
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      try { resolvePromise(JSON.parse(input) as SessionReply); }
      catch { reject(new Error(`Invalid response from session ${socketPath}`)); }
    });
  });
}

export async function sessionRecords(): Promise<SessionRecord[]> {
  try {
    const reply = await supervisorRequest({ command: "sessions" });
    const records = (reply.records ?? []).filter((record: SessionRecord & { product?: string }) => record.product === "agyx");
    if (records.length) return records;
  } catch {
    // Fall back to legacy per-session records during upgrades.
  }
  await ensureDirectories();
  const entries = await readdir(runtimeDir);
  const records: SessionRecord[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const path = join(runtimeDir, entry);
    try {
      const record = parseJSONPrefix<SessionRecord>(await readFile(path, "utf8"));
      process.kill(record.pid, 0);
      await writeRuntimeRecord(path, record);
      records.push(record);
    } catch {
      await rm(path, { force: true });
    }
  }
  return records;
}

export async function activeQuotaScopes(): Promise<QuotaScope[]> {
  const scopes = new Set<QuotaScope>();
  for (const record of await sessionRecords()) {
    const scope = record.currentQuotaScope;
    if (scope && scope !== "unknown") scopes.add(canonicalQuotaScope(scope));
  }
  return [...scopes];
}

export async function withAuthSwitchLock<T>(
  operation: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  if (authSwitchLockDepth > 0) return await operation();
  await ensureDirectories();
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const staleMs = options.staleMs ?? 30 * 60_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(authSwitchLockPath, { mode: 0o700 });
      await writeFile(
        join(authSwitchLockPath, "owner"),
        `${process.pid}\n${new Date().toISOString()}\n`,
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(authSwitchLockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
        await rm(authSwitchLockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for agyx auth switch lock.");
      }
      await sleep(100);
    }
  }

  authSwitchLockDepth += 1;
  try {
    return await operation();
  } finally {
    authSwitchLockDepth -= 1;
    if (authSwitchLockDepth === 0) {
      await rm(authSwitchLockPath, { recursive: true, force: true });
    }
  }
}

interface AgySessionControlOptions {
  reason?: string;
  resumePromptFor?: (record: SessionRecord) => string | undefined;
  onResumeError?: (record: SessionRecord, error: unknown) => void;
  sessionRecords?: () => Promise<SessionRecord[]>;
}

function isContinuationSession(
  record: SessionRecord,
  continuation: PendingQuotaContinuation,
): boolean {
  return Boolean(continuation.sessionId)
    && (record.conversationId === continuation.sessionId
      || record.launcherId === continuation.sessionId
      || record.id === continuation.sessionId);
}

function sessionControlAdapter(options: AgySessionControlOptions = {}): SessionControlAdapter<SessionRecord> {
  return {
    sessionRecords: options.sessionRecords ?? sessionRecords,
    pause: async (record) => {
      if ((record as SessionRecord & { launcherId?: string }).launcherId) {
        const reply = await supervisorRequest({
          command: "pause",
          launcherId: (record as SessionRecord & { launcherId?: string }).launcherId,
          reason: options.reason,
        });
        return reply.record as SessionRecord;
      }
      const reply = await send(record.socketPath, "pause", { reason: options.reason });
      if (!reply.ok) {
        if (!reply.error?.includes("Unexpected non-whitespace character after JSON")) {
          throw new Error(reply.error ?? `Failed to pause ${record.id}`);
        }
        return {
          ...record,
          childPid: undefined,
          paused: true,
        };
      }
      return reply.record ?? { ...record, childPid: undefined, paused: true };
    },
    notify: async (record, message) => {
      if ((record as SessionRecord & { launcherId?: string }).launcherId) {
        await supervisorRequest({
          command: "notice",
          launcherId: (record as SessionRecord & { launcherId?: string }).launcherId,
          message,
        });
        return;
      }
      const reply = await send(record.socketPath, "notice", { message });
      if (!reply.ok) throw new Error(reply.error ?? `Failed to notify ${record.id}`);
    },
    afterPause: async (paused) => {
      if (process.env.AGYX_SKIP_UNMANAGED_AGY_STOP === "1") return;
      const managedPIDs = new Set(paused.map((record) => record.childPid).filter(Boolean));
      const unmanaged = (await runningAgy()).filter(({ pid }) => !managedPIDs.has(pid));
      if (unmanaged.length) await stopProcesses(unmanaged);
    },
    resume: async (record) => {
      const prompt = options.resumePromptFor?.(record);
      if ((record as SessionRecord & { launcherId?: string }).launcherId) {
        await supervisorRequest({
          command: "resume",
          launcherId: (record as SessionRecord & { launcherId?: string }).launcherId,
          reason: options.reason,
          prompt,
        });
        return;
      }
      const reply = await send(record.socketPath, "resume", { reason: options.reason, prompt });
      if (!reply.ok) throw new Error(reply.error);
    },
    onResumeError: (record, error) => {
      console.error(`agyx: failed to resume session ${record.id}: ${(error as Error).message}`);
      options.onResumeError?.(record, error);
    },
  };
}

interface AgyAuthSwitchOptions extends AuthSwitchTransactionOptions {
  continuations?: PendingQuotaContinuation[];
  onContinuationComplete?: (
    continuation: PendingQuotaContinuation,
    result: { transport: "managed" | "legacy" },
  ) => void;
  onContinuationSkipped?: (
    continuation: PendingQuotaContinuation,
    result: { transport: "unavailable" },
  ) => void;
  onContinuationError?: (error: unknown, continuation: PendingQuotaContinuation) => void;
}

async function withPausedAuthSwitch<T>(
  operation: () => Promise<T>,
  options: AgyAuthSwitchOptions = {},
): Promise<T> {
  const records = await sessionRecords();
  const continuations = options.continuations ?? [];
  const continuationForRecord = (record: SessionRecord) =>
    continuations.find((continuation) => isContinuationSession(record, continuation));
  const continuationRecords = new Map<string, SessionRecord>();
  for (const record of records) {
    const continuation = continuationForRecord(record);
    if (continuation) continuationRecords.set(continuation.sessionId, record);
  }
  const failedContinuationSessionIds = new Set<string>();
  let switchCompleted = false;
  const result = await runAuthSwitchTransaction(
    {
      sessionControl: sessionControlAdapter({
        reason: "profile-switch",
        sessionRecords: async () => records,
        resumePromptFor: (record) => switchCompleted
          ? continuationForRecord(record)
            ? agentCliManifests.agy.quotaFailover.postSwitchContinuationPrompt
            : undefined
          : undefined,
        onResumeError: (record, error) => {
          const continuation = continuationForRecord(record);
          if (!switchCompleted || !continuation) return;
          failedContinuationSessionIds.add(continuation.sessionId);
          options.onContinuationError?.(error, continuation);
        },
      }),
      withLock: withAuthSwitchLock,
    },
    async () => {
      const value = await operation();
      switchCompleted = true;
      return value;
    },
    options,
  );

  for (const continuation of continuations) {
    const record = continuationRecords.get(continuation.sessionId);
    if (!record) {
      options.onContinuationSkipped?.(continuation, { transport: "unavailable" });
      continue;
    }
    if (!failedContinuationSessionIds.has(continuation.sessionId)) {
      options.onContinuationComplete?.(continuation, {
        transport: record.launcherId ? "managed" : "legacy",
      });
    }
  }
  return result;
}

export async function continueAgyQuotaSession(
  continuation: PendingQuotaContinuation,
  options: { sessionRecords?: () => Promise<SessionRecord[]> } = {},
): Promise<{ continued: boolean; transport: "managed" | "legacy" | "unavailable" }> {
  const records = await (options.sessionRecords ?? sessionRecords)();
  const record = records.find((candidate) => isContinuationSession(candidate, continuation));
  if (!record) return { continued: false, transport: "unavailable" };
  const control = sessionControlAdapter({
    reason: "profile-switch",
    sessionRecords: async () => records,
    resumePromptFor: () => agentCliManifests.agy.quotaFailover.postSwitchContinuationPrompt,
  });
  const paused = await control.pause(record);
  if (!control.resume) throw new Error("Agy session adapter does not implement resume.");
  await control.resume(paused);
  return {
    continued: true,
    transport: record.launcherId ? "managed" : "legacy",
  };
}

export async function withPausedCredentialOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return await withPausedAuthSwitch(operation);
}

export async function pauseAll(): Promise<SessionRecord[]> {
  return await pauseAllSessions(sessionControlAdapter());
}

export async function resumeAll(records: SessionRecord[]): Promise<void> {
  const managed = records.filter((record) => (record as SessionRecord & { launcherId?: string }).launcherId);
  const legacy = records.filter((record) => !(record as SessionRecord & { launcherId?: string }).launcherId);
  if (managed.length) await supervisorRequest({ command: "resume-all", product: "agyx" });
  if (legacy.length) await resumeAllSessions(sessionControlAdapter(), legacy);
}

export interface ProfileCaptureResult {
  name: string;
  email?: string;
}

export interface ProfileSwitchResult {
  name: string;
  email?: string;
  alreadyActive?: boolean;
}

export async function persistActiveProfileCredential(
  state?: State,
): Promise<boolean> {
  const currentState = state ?? await loadState();
  return await persistCurrentCredential({
    readCurrentCredential: async () => await keychain.readActive().catch(() => undefined),
    credentialIsValid: isValidAgyCredential,
    writeProfileCredential: async (name, credential) => await keychain.writeProfile(name, credential),
  }, currentState.activeProfile);
}

function resolveProfileName(
  state: Awaited<ReturnType<typeof loadState>>,
  nameInput: string | undefined,
  email: string | undefined,
  context: "save" | "login",
): string {
  if (nameInput) return validateProfileName(nameInput);
  if (!email) {
    throw new Error(
      context === "save"
        ? "Usage: agyx save [name] [--email EMAIL]. Profile name could not be inferred because no active Google account email was found."
      : "Usage: agyx login [name] [--email EMAIL] [--no-resume]. Profile name could not be inferred because login email was not detected.",
    );
  }
  const existingByEmail = state.profiles.find((profile) => profile.email === email);
  if (existingByEmail) return existingByEmail.name;
  return uniqueProfileName(profileNameFromEmail(email), state);
}

export async function saveCurrent(
  nameInput?: string,
  explicitEmail?: string,
): Promise<ProfileCaptureResult> {
  return await withAuthSwitchLock(async () => {
    const state = await loadState();
    const activeProfileEmail = state.profiles.find(
      (profile) => profile.name === state.activeProfile,
    )?.email;
    const probeLogPath = join(logDir, `email-probe-${Date.now()}.log`);
    const email = explicitEmail
      ?? await detectActiveEmail(probeLogPath)
      ?? (nameInput ? activeProfileEmail : undefined);
    const name = resolveProfileName(state, nameInput, email, "save");
    const credential = await keychain.readActive();
    await keychain.writeProfile(name, credential);
    await upsertProfile(name, email, true, false);
    return { name, email };
  });
}

async function verifyActiveCredential(
  state: State,
  name: string,
): Promise<string> {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) throw new Error(`Profile not found: ${name}`);
  const expectedEmail = profile.email;
  const initialCredential = await keychain.readActive();
  let actualEmail = await detectCredentialEmail(initialCredential);
  if (!actualEmail) {
    actualEmail = await detectActiveEmail(
      join(logDir, `verify-${name}-${Date.now()}.log`),
    );
  }
  const refreshedCredential = await keychain.readActive();
  actualEmail = actualEmail ?? await detectCredentialEmail(refreshedCredential);
  if (!actualEmail) {
    markProfileCredentialMismatch(state, name, undefined, expectedEmail);
    await saveState(state);
    throw new Error(
      `Profile '${name}' credential could not be verified. No authenticated email was detected.`,
    );
  }
  if (expectedEmail && actualEmail !== expectedEmail) {
    markProfileCredentialMismatch(state, name, actualEmail, expectedEmail);
    await saveState(state);
    throw new Error(
      `Profile '${name}' credential mismatch: expected ${expectedEmail}, got ${actualEmail}.`,
    );
  }
  await keychain.writeProfile(name, refreshedCredential);
  markProfileCredentialVerified(state, name, actualEmail);
  return actualEmail;
}

export async function activateProfile(
  nameInput: string,
  options: { verify?: boolean } = {},
): Promise<ProfileSwitchResult> {
  return await withAuthSwitchLock(async () => {
    const name = validateProfileName(nameInput);
    const state = await loadState();
    if (!state.profiles.some((profile) => profile.name === name)) {
      throw new Error(`Profile not found: ${name}`);
    }
    // The active Agy slot may contain a newly refreshed access token. Reconcile
    // it before replacing the slot with another saved profile.
    await persistActiveProfileCredential(state);
    const credential = await keychain.readProfile(name);
    await keychain.writeActive(credential);
    const email = options.verify ? await verifyActiveCredential(state, name) : undefined;
    markProfileActivated(state, name);
    await saveState(state);
    return { name, email };
  });
}

export async function switchProfile(
  name: string,
  options: { force?: boolean } = {},
): Promise<ProfileSwitchResult> {
  return await withPausedAuthSwitch(async () => {
    const initialState = await loadState();
    const quotaScopes = await activeQuotaScopes();
    const profile = initialState.profiles.find((entry) => entry.name === name);
    if (!profile) throw new Error(`Profile not found: ${name}`);
    if (initialState.activeProfile === name) {
      await logSwitchEvent({
        event: "switch.skipped",
        trigger: "manual-use",
        fromProfile: initialState.activeProfile,
        toProfile: name,
        reason: "already_active",
      });
      return {
        name,
        email: profile.email ?? profile.verifiedEmail,
        alreadyActive: true,
      };
    }
    const selectionOptions = {
      quotaScopes,
      allowIneligibleActivation: effectiveAllowIneligibleActivation(initialState),
    };
    const selectable = isProfileSelectable(profile, new Date(), selectionOptions);
    const status = effectiveProfileStatus(profile, new Date(), selectionOptions);
    const decision = decideExplicitProfileUse({
      name,
      active: false,
      selectable,
      disabledReason: selectable ? undefined : status,
    });
    if (decision.type === "confirm" && !options.force) {
      throw new Error(`Profile '${name}' is not selectable: ${decision.reason}.`);
    }
    const previousCredential = await keychain.readActive().catch(() => undefined);
    try {
      await logSwitchEvent({
        event: "profile.selected",
        trigger: "manual-use",
        fromProfile: initialState.activeProfile,
        toProfile: name,
      });
      const result = await activateProfile(name, { verify: true });
      await logSwitchEvent({
        event: "switch.completed",
        trigger: "manual-use",
        fromProfile: initialState.activeProfile,
        toProfile: result.name,
      });
      return result;
    } catch (error) {
      if (previousCredential) await keychain.writeActive(previousCredential);
      await logSwitchEvent({
        event: "switch.failed",
        trigger: "manual-use",
        fromProfile: initialState.activeProfile,
        toProfile: name,
        error: (error as Error).message,
      });
      throw error;
    }
  });
}

export async function switchToNextProfile(): Promise<ProfileSwitchResult> {
  return await withPausedAuthSwitch(async () => {
    const initialState = await loadState();
    const quotaScopes = await activeQuotaScopes();
    const initialCandidate = selectNextProfile(initialState, new Date(), { quotaScopes });
    if (initialCandidate.name === initialState.activeProfile) {
      await logSwitchEvent({
        event: "switch.skipped",
        trigger: "manual-next",
        fromProfile: initialState.activeProfile,
        toProfile: initialCandidate.name,
        reason: "already_active",
      });
      return {
        name: initialCandidate.name,
        email: initialCandidate.email ?? initialCandidate.verifiedEmail,
        alreadyActive: true,
      };
    }
    const previousCredential = await keychain.readActive().catch(() => undefined);
    let lastError: Error | undefined;
    try {
      for (let attempt = 0; attempt < 10000; attempt += 1) {
        const state = await loadState();
        const candidate = selectNextProfile(state, new Date(), { quotaScopes });
        if (candidate.name === state.activeProfile) {
          await logSwitchEvent({
            event: "switch.skipped",
            trigger: "manual-next",
            fromProfile: state.activeProfile,
            toProfile: candidate.name,
            reason: "already_active",
          });
          return {
            name: candidate.name,
            email: candidate.email ?? candidate.verifiedEmail,
            alreadyActive: true,
          };
        }
        try {
          await logSwitchEvent({
            event: "profile.selected",
            trigger: "manual-next",
            fromProfile: state.activeProfile,
            toProfile: candidate.name,
          });
          const result = await activateProfile(candidate.name, { verify: true });
          await logSwitchEvent({
            event: "switch.completed",
            trigger: "manual-next",
            fromProfile: state.activeProfile,
            toProfile: result.name,
          });
          return result;
        } catch (error) {
          lastError = error as Error;
          const profile = (await loadState()).profiles.find((entry) => entry.name === candidate.name);
          if (!profile || !["mismatch", "error"].includes(profile.credentialStatus ?? "")) {
            throw error;
          }
        }
      }
      throw lastError ?? new Error("No selectable profiles.");
    } catch (error) {
      if (previousCredential) await keychain.writeActive(previousCredential);
      await logSwitchEvent({
        event: "switch.failed",
        trigger: "manual-next",
        fromProfile: initialState.activeProfile,
        error: (error as Error).message,
      });
      throw error;
    }
  });
}

export async function setAutoSwitchMode(mode: AutoSwitchMode): Promise<void> {
  const state = await loadState();
  state.settings = state.settings ?? {};
  state.settings.autoSwitchMode = mode;
  await saveState(state);
}

export async function setAllowIneligibleActivation(allow: boolean): Promise<void> {
  const state = await loadState();
  state.settings = state.settings ?? {};
  state.settings.allowIneligibleActivation = allow;
  await saveState(state);
}

export interface AgyQuotaObservation {
  sessionId?: string;
  conversationId?: string;
  launcherId?: string;
  profileName?: string;
  timestamp?: string;
}

interface AgyQuotaFailoverResult extends ProfileSwitchResult {
  switched: boolean;
  continuedSessionIds: string[];
  reason?: string;
}

function observedAgySessionId(observation?: AgyQuotaObservation): string | undefined {
  return observation?.sessionId
    ?? observation?.conversationId
    ?? observation?.launcherId;
}

async function queueFailedAgySession(
  state: State,
  observation?: AgyQuotaObservation,
): Promise<State> {
  const sessionId = observedAgySessionId(observation);
  const prompt = agentCliManifests.agy.quotaFailover.postSwitchContinuationPrompt;
  if (!sessionId || !prompt) return state;
  const updated: State = {
    ...state,
    pendingQuotaContinuations: enqueuePendingQuotaContinuation(
      state.pendingQuotaContinuations ?? [],
      {
        sessionId,
        profileName: observation?.profileName,
        queuedAt: observation?.timestamp ?? new Date().toISOString(),
      },
    ),
  };
  await saveState(updated);
  return updated;
}

async function removeCompletedAgySessions(sessionIds: string[]): Promise<void> {
  if (!sessionIds.length) return;
  const state = await loadState();
  const pending = state.pendingQuotaContinuations ?? [];
  const remaining = removeCompletedQuotaContinuations(pending, sessionIds);
  if (remaining.length === pending.length) return;
  state.pendingQuotaContinuations = remaining;
  await saveState(state);
}

async function logAgyContinuationOutcome(
  continuation: PendingQuotaContinuation,
  status: "completed" | "skipped" | "failed",
  reason: string,
  transport?: string,
  error?: unknown,
): Promise<void> {
  await logSwitchEvent({
    event: `continuation.${status}`,
    trigger: "autoswitch",
    reason,
    sessionId: continuation.sessionId,
    profile: (await loadState()).activeProfile,
    transport,
    error: error instanceof Error ? error.message : (error ? String(error) : undefined),
  });
}

async function continuePendingAgySessions(
  state: State,
  reason: string,
): Promise<string[]> {
  const completed: string[] = [];
  for (const continuation of state.pendingQuotaContinuations ?? []) {
    try {
      const result = await continueAgyQuotaSession(continuation);
      if (result.continued) completed.push(continuation.sessionId);
      await logAgyContinuationOutcome(
        continuation,
        result.continued ? "completed" : "skipped",
        reason,
        result.transport,
      );
    } catch (error) {
      await logAgyContinuationOutcome(continuation, "failed", reason, undefined, error);
    }
  }
  await removeCompletedAgySessions(completed);
  return completed;
}

export async function autoSwitchAfterQuota(
  quotaScope: QuotaScope,
  observation?: AgyQuotaObservation,
): Promise<AgyQuotaFailoverResult | undefined> {
  return await withAuthSwitchLock(async () => {
    const failoverPolicy = decideLiveQuotaFailover(true);
    if (!failoverPolicy.switchImmediately) return undefined;
    const initialState = await queueFailedAgySession(await loadState(), observation);
    const observedProfile = observation?.profileName;
    const sessionId = observedAgySessionId(observation);
    if (observedProfile || sessionId) {
      const ownership = decideObservedProfileFailover(observedProfile, initialState.activeProfile);
      if (!ownership.switchProfile) {
        await logSwitchEvent({
          event: "switch.stopped",
          trigger: "autoswitch",
          reason: ownership.reason,
          fromProfile: observedProfile,
          activeProfile: initialState.activeProfile,
          sessionId,
          quotaScope,
        });
        const completed = ownership.continueFailedSession
          ? await continuePendingAgySessions(initialState, ownership.reason)
          : [];
        return initialState.activeProfile
          ? {
              name: initialState.activeProfile,
              alreadyActive: true,
              switched: false,
              continuedSessionIds: completed,
              reason: ownership.reason,
            }
          : undefined;
      }
    }
    const mode = effectiveAutoSwitchMode(initialState);
    if (mode === "off") {
      await logSwitchEvent({
        event: "switch.stopped",
        trigger: "autoswitch",
        reason: "autoswitch_off",
        fromProfile: initialState.activeProfile,
        quotaScope,
      });
      return undefined;
    }
    const activeProfile = initialState.profiles.find((profile) =>
      profile.name === initialState.activeProfile
    );
    if (!shouldAutoSwitchAfterQuota(activeProfile, mode, quotaScope)) {
      await logSwitchEvent({
        event: "switch.stopped",
        trigger: "autoswitch",
        reason: "quota_scope_not_switchable",
        fromProfile: initialState.activeProfile,
        quotaScope,
        mode,
      });
      return undefined;
    }

    const continuations = initialState.pendingQuotaContinuations ?? [];
    const continuationOutcomes: Array<{
      status: "completed" | "skipped" | "failed";
      continuation: PendingQuotaContinuation;
      transport?: string;
      error?: unknown;
    }> = [];
    const switched = await withPausedAuthSwitch(async () => {
      const initialCandidate = selectAutoSwitchProfile(initialState, mode, quotaScope);
      const previousCredential = await keychain.readActive().catch(() => undefined);
      let lastError: Error | undefined;
      try {
        for (let attempt = 0; attempt < 10000; attempt += 1) {
          const state = await loadState();
          const currentMode = effectiveAutoSwitchMode(state);
          if (currentMode === "off") {
            throw new Error("Automatic quota failover was disabled during profile selection.");
          }
          const candidate = attempt === 0
            ? initialCandidate
            : selectAutoSwitchProfile(state, currentMode, quotaScope);
          try {
            await logSwitchEvent({
              event: "profile.selected",
              trigger: "autoswitch",
              fromProfile: state.activeProfile,
              toProfile: candidate.name,
              quotaScope,
              mode: currentMode,
            });
            const result = await activateProfile(candidate.name, { verify: true });
            await logSwitchEvent({
              event: "switch.completed",
              trigger: "autoswitch",
              fromProfile: state.activeProfile,
              toProfile: result.name,
              quotaScope,
              mode: currentMode,
            });
            return result;
          } catch (error) {
            lastError = error as Error;
            const profile = (await loadState()).profiles.find((entry) => entry.name === candidate.name);
            if (!profile || !["mismatch", "error"].includes(profile.credentialStatus ?? "")) {
              throw error;
            }
          }
        }
        throw lastError ?? new Error("No selectable profile for automatic quota failover.");
      } catch (error) {
        if (previousCredential) await keychain.writeActive(previousCredential);
        await logSwitchEvent({
          event: "switch.failed",
          trigger: "autoswitch",
          fromProfile: initialState.activeProfile,
          quotaScope,
          mode,
          error: (error as Error).message,
        });
        throw error;
      }
    }, {
      switchingNotice: quotaSwitchingNotice("agyx"),
      continuations,
      onContinuationComplete: (continuation, result) => {
        continuationOutcomes.push({ status: "completed", continuation, transport: result.transport });
      },
      onContinuationSkipped: (continuation, result) => {
        continuationOutcomes.push({ status: "skipped", continuation, transport: result.transport });
      },
      onContinuationError: (error, continuation) => {
        continuationOutcomes.push({ status: "failed", continuation, error });
      },
    });
    const completed = continuationOutcomes
      .filter((outcome) => outcome.status === "completed")
      .map((outcome) => outcome.continuation.sessionId);
    await removeCompletedAgySessions(completed);
    for (const outcome of continuationOutcomes) {
      await logAgyContinuationOutcome(
        outcome.continuation,
        outcome.status,
        "profile_switched",
        outcome.transport,
        outcome.error,
      );
    }
    return {
      ...switched,
      switched: true,
      continuedSessionIds: completed,
    };
  });
}

export async function autoSwitchAfterQuotaAction(
  quotaScope: QuotaScope,
  observation?: AgyQuotaObservation,
): Promise<AutoSwitchAction> {
  try {
    const result = await autoSwitchAfterQuota(quotaScope, observation);
    if (!result) return { kind: "none" };
    if (!result.switched) {
      if (!result.continuedSessionIds.length) return { kind: "none", reason: result.reason };
      return {
        kind: "sessions_restarted",
        reason: result.reason,
        profile: result.name,
        sessionIds: result.continuedSessionIds,
        message: `\n[agyx] '${result.name}' is already active; continued ${result.continuedSessionIds.length} quota-failed session(s).`,
      };
    }
    return {
      kind: "switched",
      profile: result.name,
      email: result.email,
      message: `\n[agyx] Switched to profile '${result.name}' after quota was reached.`,
    };
  } catch (error) {
    return {
      kind: "stop_retrying",
      reason: "auto_switch_failed",
      retryKey: `quota:${quotaScope}`,
      message: `\n[agyx] Automatic quota failover stopped: ${(error as Error).message}`,
    };
  }
}

export async function verifyAllProfiles(): Promise<State> {
  return await withPausedAuthSwitch(async () => {
    const previousProfile = (await loadState()).activeProfile;
    await persistActiveProfileCredential();
    const previousCredential = await keychain.readActive().catch(() => undefined);
    try {
      const names = (await loadState()).profiles.map((profile) => profile.name);
      for (const name of names) {
        const state = await loadState();
        if (!state.profiles.some((profile) => profile.name === name)) continue;
        try {
          const credential = await keychain.readProfile(name);
          await keychain.writeActive(credential);
          await verifyActiveCredential(state, name);
          await saveState(state);
        } catch (error) {
          const currentState = await loadState();
          const profile = currentState.profiles.find((entry) => entry.name === name);
          if (profile && profile.credentialStatus !== "mismatch") {
            markProfileCredentialMismatch(
              currentState,
              name,
              undefined,
              profile.email,
            );
            await saveState(currentState);
          }
        }
      }
      return await loadState();
    } finally {
      const restoredCredential = previousProfile
        ? await keychain.readProfile(previousProfile).catch(() => previousCredential)
        : previousCredential;
      if (restoredCredential) await keychain.writeActive(restoredCredential);
    }
  });
}

export function detectEmail(content: string): string | undefined {
  const matches = [...content.matchAll(
    /authenticated successfully as ([^\s]+@[^\s]+)/gi,
  )];
  return matches.at(-1)?.[1];
}

async function detectActiveEmail(logPath: string): Promise<string | undefined> {
  const realAgy = await findRealAgy();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(realAgy, ["--log-file", logPath], {
      stdio: "ignore",
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGYX_EMAIL_PROBE: "1",
      },
    });
    let settled = false;
    let interval: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;
    const finish = (email: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGTERM");
      resolvePromise(email);
    };
    interval = setInterval(async () => {
      try {
        const email = detectEmail(await readFile(logPath, "utf8"));
        if (email) finish(email);
      } catch {
        // Wait for the log file and auth line.
      }
    }, 200);
    timeout = setTimeout(() => finish(undefined), 7000);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", async () => {
      if (settled) return;
      try {
        finish(detectEmail(await readFile(logPath, "utf8")));
      } catch {
        finish(undefined);
      }
    });
  });
}

async function interactiveLogin(logPath: string): Promise<string | undefined> {
  const realAgy = await findRealAgy();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(realAgy, ["--log-file", logPath], { stdio: "inherit" });
    let detectedEmail: string | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    const interval = setInterval(async () => {
      try {
        const email = detectEmail(await readFile(logPath, "utf8"));
        if (!email || detectedEmail) return;
        detectedEmail = email;
        clearInterval(interval);
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGTERM");
          terminationTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, 5000);
        }, 750);
      } catch {
        // Wait for the log file and successful OAuth line.
      }
    }, 200);
    child.on("error", (error) => {
      clearInterval(interval);
      reject(error);
    });
    child.on("exit", () => {
      clearInterval(interval);
      if (terminationTimer) clearTimeout(terminationTimer);
      resolvePromise(detectedEmail);
    });
  });
}

export async function loginProfile(
  nameInput?: string,
  explicitEmail?: string,
  resume = true,
): Promise<ProfileCaptureResult> {
  return await withPausedAuthSwitch(async () => {
    const state = await loadState();
    const previousCredential = await keychain.readActive().catch(() => undefined);
    if (state.activeProfile && previousCredential) {
      await keychain.writeProfile(state.activeProfile, previousCredential);
    }

    const logPath = join(logDir, `login-${Date.now()}.log`);
    try {
      await keychain.deleteActive();
      console.log("Complete Google sign-in in the browser. agyx will continue automatically.");
      const detectedEmail = await interactiveLogin(logPath);
      const credential = await keychain.readActive().catch(() => undefined);
      if (!credential) throw new Error("Login ended without creating an agy credential.");
      const email = explicitEmail ?? detectedEmail;
      const name = resolveProfileName(await loadState(), nameInput, email, "login");
      await keychain.writeProfile(name, credential);
      await upsertProfile(name, email, true);
      console.log(`Captured and activated profile '${name}'.`);
      return { name, email };
    } catch (error) {
      if (previousCredential) await keychain.writeActive(previousCredential);
      await saveState(state);
      throw error;
    }
  }, { resume });
}
