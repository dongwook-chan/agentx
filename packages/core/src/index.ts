import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface FirstLineReadResult {
  line?: string;
  truncated: boolean;
}

export async function readFirstLineBounded(
  path: string,
  options: { maxBytes?: number; chunkSize?: number } = {},
): Promise<FirstLineReadResult> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const chunkSize = Math.max(1, Math.min(options.chunkSize ?? 4096, maxBytes));
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal < maxBytes) {
      const remaining = maxBytes - bytesReadTotal;
      const buffer = Buffer.alloc(Math.min(chunkSize, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytesReadTotal);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newlineAt = chunk.indexOf(0x0a);
      if (newlineAt >= 0) {
        chunks.push(chunk.subarray(0, newlineAt));
        const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
        return { line, truncated: false };
      }
      chunks.push(chunk);
      bytesReadTotal += bytesRead;
    }
    const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
    return { line: line || undefined, truncated: bytesReadTotal >= maxBytes };
  } finally {
    await handle.close();
  }
}

export interface IncrementalFileTailRead {
  text: string;
  lines: string[];
  offset: number;
  lineNumber: number;
}

export class IncrementalFileTail {
  readonly file: string;
  offset: number;
  lineNumber: number;
  private carry = "";
  private decoder = new StringDecoder("utf8");

  constructor(file: string, options: { offset?: number; lineNumber?: number } = {}) {
    this.file = file;
    this.offset = options.offset ?? 0;
    this.lineNumber = options.lineNumber ?? 0;
  }

  async readAdded(): Promise<IncrementalFileTailRead | undefined> {
    const info = await stat(this.file).catch(() => undefined);
    if (!info) return undefined;
    if (info.size < this.offset) {
      this.offset = 0;
      this.lineNumber = 0;
      this.carry = "";
      this.decoder = new StringDecoder("utf8");
    }
    if (info.size === this.offset) return undefined;

    const size = info.size - this.offset;
    const buffer = Buffer.alloc(size);
    const handle = await open(this.file, "r");
    try {
      await handle.read(buffer, 0, size, this.offset);
    } finally {
      await handle.close();
    }
    this.offset = info.size;

    const rawText = this.carry + this.decoder.write(buffer);
    const split = rawText.split(/\r?\n/);
    const ended = rawText.endsWith("\n") || rawText.endsWith("\r");
    if (ended) {
      split.pop();
      this.carry = "";
    } else {
      this.carry = split.pop() ?? "";
    }
    const lines = split;
    if (!lines.length) return undefined;
    const text = lines.length ? `${lines.join("\n")}${ended ? "\n" : ""}` : "";
    this.lineNumber += lines.length;
    return { text, lines, offset: this.offset, lineNumber: this.lineNumber };
  }
}

export interface LaunchPolicy {
  productName: string;
  yoloEnabled: boolean;
  yoloFlag: string;
  foreignYoloFlags: readonly string[];
  foreignFlagLabel: string;
}

function hasArg(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function applyLaunchPolicy(
  args: readonly string[],
  policy: LaunchPolicy,
): string[] {
  for (const flag of policy.foreignYoloFlags) {
    if (hasArg(args, flag)) {
      throw new Error(
        `${flag} is a ${policy.foreignFlagLabel} option. For ${policy.productName} use ${policy.yoloFlag}.`,
      );
    }
  }

  const result = [...args];
  if (policy.yoloEnabled && !hasArg(result, policy.yoloFlag)) {
    result.unshift(policy.yoloFlag);
  }
  return result;
}

export interface UseProfileCandidate {
  name: string;
  active?: boolean;
  selectable: boolean;
  disabledReason?: string;
}

export type UseProfileDecision =
  | { type: "empty"; message: "No saved profiles." }
  | { type: "none"; message: string; reason: "active_only" | "no_selectable" }
  | { type: "select"; candidates: UseProfileCandidate[] };

export function useProfileDisabledReason(
  candidate: UseProfileCandidate,
): string | undefined {
  if (candidate.active) return "already active";
  if (!candidate.selectable) return candidate.disabledReason ?? "not selectable";
  return undefined;
}

export function decideUseProfile(
  candidates: readonly UseProfileCandidate[],
): UseProfileDecision {
  if (!candidates.length) return { type: "empty", message: "No saved profiles." };
  return { type: "select", candidates: [...candidates] };
}

export const explicitProfileUsePolicy = {
  unavailableProfileAction: "confirm",
  confirmationDefault: false,
} as const;

export type ExplicitProfileUseDecision =
  | { type: "already-active" }
  | { type: "activate"; force: false }
  | { type: "confirm"; force: true; reason: string; message: string; defaultValue: false };

/**
 * Manual profile selection is an explicit user override, not automatic
 * failover. Unavailable profiles therefore remain chooseable, but require a
 * negative-default confirmation before adapters bypass their normal guards.
 */
export function decideExplicitProfileUse(
  candidate: UseProfileCandidate,
): ExplicitProfileUseDecision {
  if (candidate.active) return { type: "already-active" };
  if (candidate.selectable) return { type: "activate", force: false };
  const reason = candidate.disabledReason ?? "not selectable";
  return {
    type: explicitProfileUsePolicy.unavailableProfileAction,
    force: true,
    reason,
    message: `Profile '${candidate.name}' is marked ${reason}. Switch anyway?`,
    defaultValue: explicitProfileUsePolicy.confirmationDefault,
  };
}

export interface LoginSemantics {
  command: readonly string[];
  clearsActiveCredentialAtStart: boolean;
  requiresActiveSlotClearedBeforeLogin: boolean;
  isolatesLoginEnvironment: boolean;
  mustRestorePreviousActiveOnFailure: boolean;
  successRequiresCredentialValidation: boolean;
}

export interface CredentialSemantics {
  activeLocations: readonly string[];
  savedProfileLocation: string;
  lifecycle: CredentialLifecyclePolicy;
}

export interface CredentialLifecyclePolicy {
  activeCredentialMayMutate: true;
  persistActiveBeforeReplacement: true;
  persistAfterRefreshCapableOperation: true;
  isolatedCredentialMutationsMustMergeBack: true;
  concurrentRefreshesAllowed: false;
}

/**
 * OAuth providers differ in whether refresh tokens rotate, but wrappers must
 * treat every active credential as mutable. This stricter policy also covers
 * reusable refresh tokens and keeps saved profiles from retaining expired
 * access-token snapshots.
 */
export const credentialLifecyclePolicy: CredentialLifecyclePolicy = {
  activeCredentialMayMutate: true,
  persistActiveBeforeReplacement: true,
  persistAfterRefreshCapableOperation: true,
  isolatedCredentialMutationsMustMergeBack: true,
  concurrentRefreshesAllowed: false,
};

export interface CredentialPersistenceAdapter<TCredential> {
  readCurrentCredential(): Promise<TCredential | undefined>;
  writeProfileCredential(profileName: string, credential: TCredential): Promise<void>;
  credentialIsValid?(credential: TCredential): boolean | Promise<boolean>;
}

/** Persist the current mutable credential into its canonical saved profile. */
export async function persistCurrentCredential<TCredential>(
  adapter: CredentialPersistenceAdapter<TCredential>,
  profileName: string | undefined,
): Promise<boolean> {
  if (!profileName) return false;
  const credential = await adapter.readCurrentCredential();
  if (credential === undefined) return false;
  if (adapter.credentialIsValid && !await adapter.credentialIsValid(credential)) {
    throw new Error(`Refusing to persist an invalid credential for profile '${profileName}'.`);
  }
  await adapter.writeProfileCredential(profileName, credential);
  return true;
}

/**
 * Merge credential mutations back even when the provider operation later
 * fails. A refresh can succeed before a quota/status request fails, and losing
 * that mutation can invalidate rotating refresh-token families.
 */
export async function runRefreshableCredentialOperation<TCredential, TResult>(
  adapter: CredentialPersistenceAdapter<TCredential>,
  profileName: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  let result: TResult | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  try {
    await persistCurrentCredential(adapter, profileName);
  } catch (persistenceError) {
    if (operationError !== undefined) {
      throw new AggregateError(
        [operationError, persistenceError],
        `Credential operation and persistence both failed for profile '${profileName}'.`,
      );
    }
    throw persistenceError;
  }

  if (operationError !== undefined) throw operationError;
  return result as TResult;
}

export interface AgentCliManifest {
  id: "agy" | "codex";
  packageName: string;
  executable: string;
  login: LoginSemantics;
  credentials: CredentialSemantics;
  quotaFailover: QuotaFailoverSemantics;
}

export const autoSwitchModes = ["off", "scope-first", "all-scopes"] as const;
export type AutoSwitchMode = typeof autoSwitchModes[number];
export type CandidateQuotaPolicy = "trigger-scope" | "any-scope";
export const eligibilityModes = ["allow", "block"] as const;
export type EligibilityMode = typeof eligibilityModes[number];
export const transcriptRecoveryDiagnoses = [
  "file_change_notification_missing",
  "new_file_notification_missing",
  "directory_watcher_missing",
  "notified_change_not_drained",
] as const;
export type TranscriptRecoveryDiagnosis = typeof transcriptRecoveryDiagnoses[number];

export interface UnmanagedTranscriptObservationSemantics {
  changeNotifications: "hint";
  reconcileTrackedFileSizes: boolean;
  reconcileRecentSessionDirectories: boolean;
  activeFileHorizonMs: number;
  maxReconcileDelayMs: number;
  heartbeatIntervalMs: number;
  recoveryDiagnoses: readonly TranscriptRecoveryDiagnosis[];
}

/**
 * Unmanaged transcript observation cannot rely on best-effort filesystem
 * notifications for correctness. Notifications reduce latency; bounded metadata
 * reconciliation provides delivery and the evidence needed to classify misses.
 */
export const unmanagedTranscriptObservationPolicy = {
  changeNotifications: "hint",
  reconcileTrackedFileSizes: true,
  reconcileRecentSessionDirectories: true,
  activeFileHorizonMs: 48 * 60 * 60 * 1000,
  maxReconcileDelayMs: 1_000,
  heartbeatIntervalMs: 30_000,
  recoveryDiagnoses: transcriptRecoveryDiagnoses,
} as const satisfies UnmanagedTranscriptObservationSemantics;

export interface QuotaFailoverSemantics {
  definitiveLiveExhaustionSwitchesImmediately: boolean;
  usageRefreshMayBlockFailover: boolean;
  automaticCandidateQuotaSource: "persisted-quota" | "isolated-live-status";
  verifyAllAutomaticCandidatesBeforeSelection: boolean;
  quotaWindows?: readonly { scope: string; durationMinutes: number }[];
  successfulStatusVerificationClearsCredentialFailure: boolean;
  observesUnmanagedSessionTranscripts: boolean;
  supportedAutoSwitchModes: readonly AutoSwitchMode[];
  defaultAutoSwitchMode: AutoSwitchMode;
  candidateQuotaPolicy: CandidateQuotaPolicy;
  unsupportedAutoSwitchModes?: Partial<Record<AutoSwitchMode, string>>;
  supportedEligibilityModes: readonly EligibilityMode[];
  defaultEligibilityMode?: EligibilityMode;
  unsupportedEligibilityReason?: string;
  unmanagedTranscriptObservation?: UnmanagedTranscriptObservationSemantics;
}

export interface LiveQuotaFailoverDecision {
  switchImmediately: boolean;
  usageRefreshMayBlock: false;
}

export function quotaScopeFromWindowDuration(
  windows: readonly { scope: string; durationMinutes: number }[] | undefined,
  durationMinutes: unknown,
  fallbackScope: string,
): string {
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration)) return fallbackScope;
  return windows?.find((window) => window.durationMinutes === duration)?.scope ?? "unknown";
}

export interface AutoSwitchAction {
  kind: "none" | "switched" | "sessions_restarted" | "stop_retrying";
  reason?: string;
  profile?: string;
  email?: string;
  message?: string;
  retryKey?: string;
  [key: string]: unknown;
}

export function stopRetryingAutoSwitch(
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): AutoSwitchAction {
  return {
    ok: false,
    kind: "stop_retrying",
    reason,
    message,
    ...extra,
  };
}

export function decideLiveQuotaFailover(
  definitiveExhaustion: boolean,
): LiveQuotaFailoverDecision {
  return {
    switchImmediately: definitiveExhaustion,
    usageRefreshMayBlock: false,
  };
}

export interface ObservedProfileFailoverDecision {
  switchProfile: boolean;
  reason: "profile_matches" | "missing_observed_profile" | "missing_active_profile" | "profile_already_switched";
}

/**
 * Gate a quota-triggered auth switch using the profile that owned the turn.
 * The caller must evaluate this decision while holding its auth-switch lock so
 * concurrent failures from the previous profile cannot cascade across accounts.
 */
export function decideObservedProfileFailover(
  observedProfile: string | undefined,
  activeProfile: string | undefined,
): ObservedProfileFailoverDecision {
  if (!observedProfile) return { switchProfile: false, reason: "missing_observed_profile" };
  if (!activeProfile) return { switchProfile: false, reason: "missing_active_profile" };
  if (observedProfile !== activeProfile) {
    return { switchProfile: false, reason: "profile_already_switched" };
  }
  return { switchProfile: true, reason: "profile_matches" };
}

/**
 * Tracks immutable session-to-profile ownership while allowing a parent
 * session's owner to change between turns. Child ownership is copied when the
 * child is observed, so later parent turns cannot rewrite existing children.
 */
export class SessionProfileOwnershipRegistry {
  readonly #owners = new Map<string, string>();

  owner(sessionId: string | undefined): string | undefined {
    return sessionId ? this.#owners.get(sessionId) : undefined;
  }

  bind(sessionId: string | undefined, profileName: string | undefined): string | undefined {
    if (!sessionId || !profileName) return undefined;
    this.#owners.set(sessionId, profileName);
    return profileName;
  }

  inherit(
    sessionId: string | undefined,
    parentSessionId: string | undefined,
  ): string | undefined {
    if (!sessionId || !parentSessionId) return undefined;
    return this.bind(sessionId, this.owner(parentSessionId));
  }

  forget(sessionId: string | undefined): void {
    if (sessionId) this.#owners.delete(sessionId);
  }
}

export const agentCliManifests = {
  agy: {
    id: "agy",
    packageName: "agyx",
    executable: "agy",
    login: {
      command: [],
      clearsActiveCredentialAtStart: false,
      requiresActiveSlotClearedBeforeLogin: true,
      isolatesLoginEnvironment: false,
      mustRestorePreviousActiveOnFailure: true,
      successRequiresCredentialValidation: true,
    },
    credentials: {
      activeLocations: [
        "~/.gemini/antigravity-cli/antigravity-oauth-token",
        "legacy macOS Keychain gemini/antigravity",
      ],
      savedProfileLocation: "agyx credential vault by profile name",
      lifecycle: credentialLifecyclePolicy,
    },
    quotaFailover: {
      definitiveLiveExhaustionSwitchesImmediately: true,
      usageRefreshMayBlockFailover: false,
      automaticCandidateQuotaSource: "persisted-quota",
      verifyAllAutomaticCandidatesBeforeSelection: false,
      successfulStatusVerificationClearsCredentialFailure: false,
      observesUnmanagedSessionTranscripts: false,
      supportedAutoSwitchModes: ["off", "scope-first", "all-scopes"],
      defaultAutoSwitchMode: "all-scopes",
      candidateQuotaPolicy: "trigger-scope",
      supportedEligibilityModes: ["allow", "block"],
      defaultEligibilityMode: "allow",
    },
  },
  codex: {
    id: "codex",
    packageName: "@dong-/cdxx",
    executable: "codex",
    login: {
      command: ["login"],
      clearsActiveCredentialAtStart: true,
      requiresActiveSlotClearedBeforeLogin: false,
      isolatesLoginEnvironment: true,
      mustRestorePreviousActiveOnFailure: true,
      successRequiresCredentialValidation: true,
    },
    credentials: {
      activeLocations: [
        "$CODEX_HOME/auth.json",
        "~/.codex/auth.json",
      ],
      savedProfileLocation: "cdxx profiles directory by profile name",
      lifecycle: credentialLifecyclePolicy,
    },
    quotaFailover: {
      definitiveLiveExhaustionSwitchesImmediately: true,
      usageRefreshMayBlockFailover: false,
      automaticCandidateQuotaSource: "isolated-live-status",
      verifyAllAutomaticCandidatesBeforeSelection: true,
      successfulStatusVerificationClearsCredentialFailure: true,
      quotaWindows: [
        { scope: "5h", durationMinutes: 300 },
        { scope: "weekly", durationMinutes: 10_080 },
        { scope: "monthly", durationMinutes: 43_200 },
      ],
      observesUnmanagedSessionTranscripts: true,
      supportedAutoSwitchModes: ["off", "scope-first"],
      defaultAutoSwitchMode: "off",
      candidateQuotaPolicy: "any-scope",
      unsupportedAutoSwitchModes: {
        "all-scopes": "Codex quota windows are cumulative blockers, not independently usable scopes; waiting for all windows would stall after the first exhausted window.",
      },
      supportedEligibilityModes: [],
      unsupportedEligibilityReason: "Codex auth and status data expose no eligibility state separate from credential validity, so cdxx cannot safely offer allow/block eligibility filtering.",
      unmanagedTranscriptObservation: unmanagedTranscriptObservationPolicy,
    },
  },
} as const satisfies Record<string, AgentCliManifest>;

export interface ManagedSessionRecord {
  id: string;
  pid?: number;
  childPid?: number;
  cwd?: string;
  args?: readonly string[];
  socketPath?: string;
  paused?: boolean;
  restartable?: boolean;
  startedAt?: string;
}

export interface AgentEvent {
  timestamp?: string;
  product: string;
  event: string;
  [key: string]: unknown;
}

export async function appendAgentEvent(path: string, event: AgentEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { timestamp, ...rest } = event;
  const record = {
    timestamp: timestamp ?? new Date().toISOString(),
    ...rest,
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export interface SessionControlAdapter<TRecord extends ManagedSessionRecord> {
  sessionRecords(): Promise<TRecord[]>;
  pause(record: TRecord): Promise<TRecord>;
  notify?(record: TRecord, message: string): Promise<void>;
  resume?(record: TRecord): Promise<void>;
  afterPause?(paused: readonly TRecord[]): Promise<void>;
  onResumeError?(record: TRecord, error: unknown): void;
}

export async function pauseAllSessions<TRecord extends ManagedSessionRecord>(
  adapter: SessionControlAdapter<TRecord>,
): Promise<TRecord[]> {
  const records = await adapter.sessionRecords();
  const paused: TRecord[] = [];
  for (const record of records) {
    paused.push(await adapter.pause(record));
  }
  await adapter.afterPause?.(paused);
  return paused;
}

export async function resumeAllSessions<TRecord extends ManagedSessionRecord>(
  adapter: SessionControlAdapter<TRecord>,
  records: readonly TRecord[],
): Promise<void> {
  for (const record of records) {
    try {
      if (!adapter.resume) throw new Error("Session adapter does not implement resume.");
      await adapter.resume(record);
    } catch (error) {
      if (adapter.onResumeError) adapter.onResumeError(record, error);
      else throw error;
    }
  }
}

export interface AuthSwitchTransactionAdapter<TRecord extends ManagedSessionRecord> {
  sessionControl: SessionControlAdapter<TRecord>;
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
}

export const quotaSwitchNoticeLeadingCrLfCount = 3;

export function quotaSwitchingNotice(productName: string): string {
  return "\r\n".repeat(quotaSwitchNoticeLeadingCrLfCount)
    + `[${productName}] Quota detected; switching profiles...`;
}

export interface AuthSwitchTransactionOptions {
  resume?: boolean;
  switchingNotice?: string;
}

export async function runAuthSwitchTransaction<TRecord extends ManagedSessionRecord, TResult>(
  adapter: AuthSwitchTransactionAdapter<TRecord>,
  operation: () => Promise<TResult>,
  options: AuthSwitchTransactionOptions = {},
): Promise<TResult> {
  const run = async (): Promise<TResult> => {
    const records = await pauseAllSessions(adapter.sessionControl);
    try {
      if (options.switchingNotice) {
        if (!adapter.sessionControl.notify) {
          throw new Error("Session adapter does not implement switching notices.");
        }
        for (const record of records) {
          await adapter.sessionControl.notify(record, options.switchingNotice);
        }
      }
      return await operation();
    } finally {
      if (options.resume ?? true) {
        await resumeAllSessions(adapter.sessionControl, records);
      }
    }
  };
  return adapter.withLock ? await adapter.withLock(run) : await run();
}

export type UsageCheckMode = "refresh" | "local-scan" | "state-only";

export interface UsageCheckPolicy {
  mode: UsageCheckMode;
  foregroundAllowed: boolean;
}

export const usageCheckPolicies = {
  "explicit-scan": { mode: "refresh", foregroundAllowed: true },
  "manual-record": { mode: "refresh", foregroundAllowed: true },
  "session-start": { mode: "refresh", foregroundAllowed: false },
  "live-quota-trigger": { mode: "refresh", foregroundAllowed: false },
  "background-live-quota-refresh": { mode: "refresh", foregroundAllowed: false },
  "automatic-candidate-verification": { mode: "refresh", foregroundAllowed: false },
  "session-exit": { mode: "local-scan", foregroundAllowed: true },
  list: { mode: "state-only", foregroundAllowed: true },
  use: { mode: "state-only", foregroundAllowed: true },
} as const satisfies Record<string, UsageCheckPolicy>;

export type UsageCheckReason = keyof typeof usageCheckPolicies;

export const usageCheckReasons = {
  explicitScan: "explicit-scan",
  manualRecord: "manual-record",
  sessionStart: "session-start",
  liveQuotaTrigger: "live-quota-trigger",
  backgroundLiveQuotaRefresh: "background-live-quota-refresh",
  automaticCandidateVerification: "automatic-candidate-verification",
  sessionExit: "session-exit",
  list: "list",
  use: "use",
} as const satisfies Record<string, UsageCheckReason>;

export interface UsageScopeSnapshot {
  status: "available" | "exhausted" | "unknown";
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  resetText?: string;
  reason?: string;
  checkedAt?: string;
}

export interface UsageSnapshot<TScope extends string = string> {
  source: string;
  scopes?: Partial<Record<TScope, UsageScopeSnapshot>>;
  exhausted?: boolean;
  resetAt?: string;
  reason?: string;
}

/**
 * Preserve a live exhaustion signal even when an AI CLI cannot identify the
 * affected quota scope. Explicit scope evidence wins; otherwise the generic
 * unknown scope becomes exhausted until a later usage refresh supplies detail.
 */
export function ensureExhaustedUsageScope<TScope extends string>(
  snapshot: UsageSnapshot<TScope>,
  unknownScope: TScope,
  checkedAt = new Date().toISOString(),
): UsageSnapshot<TScope> {
  if (!snapshot.exhausted) return snapshot;
  const scopes = snapshot.scopes ?? {};
  if (Object.values(scopes as Record<string, UsageScopeSnapshot | undefined>)
    .some((scope) => scope?.status === "exhausted")) {
    return snapshot;
  }
  return {
    ...snapshot,
    scopes: {
      ...scopes,
      [unknownScope]: {
        status: "exhausted",
        resetAt: snapshot.resetAt,
        reason: snapshot.reason ?? "quota exhausted",
        checkedAt,
      },
    },
  };
}

export interface UsageRefreshAdapter<TSnapshot extends UsageSnapshot = UsageSnapshot> {
  refreshUsage(reason: UsageCheckReason): Promise<TSnapshot | undefined>;
  scanLocalUsage?(reason: UsageCheckReason): Promise<TSnapshot | undefined>;
}

export function usageCheckMode(reason: UsageCheckReason): UsageCheckMode {
  return usageCheckPolicies[reason].mode;
}

export async function runUsageCheck<TSnapshot extends UsageSnapshot>(
  adapter: UsageRefreshAdapter<TSnapshot>,
  reason: UsageCheckReason,
  options: { allowLocalFallback?: boolean } = {},
): Promise<TSnapshot | undefined> {
  const mode = usageCheckMode(reason);
  if (mode === "state-only") return undefined;
  if (mode === "local-scan") return await adapter.scanLocalUsage?.(reason);

  try {
    return await adapter.refreshUsage(reason);
  } catch (error) {
    if (options.allowLocalFallback ?? true) {
      const snapshot = await adapter.scanLocalUsage?.(reason);
      if (snapshot && typeof snapshot === "object") {
        return {
          ...snapshot,
          refreshError: error instanceof Error ? error.message : String(error),
        } as TSnapshot;
      }
    }
    throw error;
  }
}

export interface GenericProfileRecord {
  name: string;
  updatedAt?: string;
  lastActivatedAt?: string;
  selectionCount?: number;
  quotaStatus?: "unknown" | "available" | "exhausted";
  quotaResetAt?: string;
  lastQuotaReason?: string;
  lastQuotaErrorAt?: string;
  disabled?: boolean;
  credentialStatus?: "unknown" | "verified" | "mismatch" | "error";
  eligibilityStatus?: "unknown" | "eligible" | "ineligible";
  quotaScopes?: Readonly<Record<string, GenericQuotaScopeRecord | undefined>>;
}

export interface GenericQuotaScopeRecord {
  status: "available" | "exhausted" | "unknown";
  resetAt?: string;
  checkedAt?: string;
  errorAt?: string;
}

export const defaultResetlessQuotaTtlMs = 24 * 60 * 60 * 1000;

export function resetlessQuotaExpired(
  checkedAt: string | undefined,
  now = new Date(),
  ttlMs = defaultResetlessQuotaTtlMs,
): boolean {
  if (!checkedAt) return false;
  const checkedMs = Date.parse(checkedAt);
  return Number.isFinite(checkedMs) && now.getTime() - checkedMs >= ttlMs;
}

export interface AutoSwitchSelectionOptions<TScope extends string = string> {
  mode: AutoSwitchMode;
  triggerScope: TScope;
  switchableScopes: readonly TScope[];
  candidateQuotaPolicy: CandidateQuotaPolicy;
  unknownScope?: TScope;
  allowIneligibleActivation?: boolean;
  scopeAliases?: (scope: TScope) => readonly TScope[];
  now?: Date;
}

function quotaResetActive(resetAt: string | undefined, now: Date): boolean {
  return !resetAt || Date.parse(resetAt) > now.getTime();
}

function profileWideQuotaActive<TProfile extends GenericProfileRecord, TScope extends string>(
  profile: TProfile,
  options: AutoSwitchSelectionOptions<TScope>,
): boolean {
  const now = options.now ?? new Date();
  if (profile.quotaStatus === "exhausted" && quotaResetActive(profile.quotaResetAt, now)) {
    return true;
  }
  const unknownScope = options.unknownScope ?? ("unknown" as TScope);
  const unknown = profile.quotaScopes?.[unknownScope];
  return Boolean(
    unknown?.status === "exhausted"
    && quotaResetActive(unknown.resetAt, now),
  );
}

export function isProfileScopeExhausted<
  TProfile extends GenericProfileRecord,
  TScope extends string,
>(
  profile: TProfile,
  scope: TScope,
  options: AutoSwitchSelectionOptions<TScope>,
): boolean {
  const now = options.now ?? new Date();
  const unknownScope = options.unknownScope ?? ("unknown" as TScope);
  if (scope === unknownScope) return profileWideQuotaActive(profile, options);
  if (profileWideQuotaActive(profile, options)) return true;
  const aliases = options.scopeAliases?.(scope) ?? [scope];
  return aliases.some((candidate) => {
    const quota = profile.quotaScopes?.[candidate];
    return quota?.status === "exhausted" && quotaResetActive(quota.resetAt, now);
  });
}

function hasAnySwitchableQuota<TProfile extends GenericProfileRecord, TScope extends string>(
  profile: TProfile,
  options: AutoSwitchSelectionOptions<TScope>,
): boolean {
  return options.switchableScopes.some((scope) =>
    isProfileScopeExhausted(profile, scope, options)
  );
}

export function shouldAutoSwitchForQuota<
  TProfile extends GenericProfileRecord,
  TScope extends string,
>(
  profile: TProfile | undefined,
  options: AutoSwitchSelectionOptions<TScope>,
): boolean {
  if (!profile || options.mode === "off") return false;
  if (options.mode === "scope-first") return true;
  const unknownScope = options.unknownScope ?? ("unknown" as TScope);
  if (options.triggerScope === unknownScope) return true;
  return options.switchableScopes.every((scope) =>
    isProfileScopeExhausted(profile, scope, options)
  );
}

function baseProfileSelectable<TProfile extends GenericProfileRecord>(
  profile: TProfile,
  allowIneligibleActivation: boolean,
): boolean {
  return !profile.disabled
    && profile.credentialStatus !== "mismatch"
    && profile.credentialStatus !== "error"
    && (profile.eligibilityStatus !== "ineligible" || allowIneligibleActivation);
}

function earliestActiveQuotaReset<TProfile extends GenericProfileRecord>(
  profile: TProfile,
  now: Date,
): number {
  const values = [
    profile.quotaResetAt,
    ...Object.values(profile.quotaScopes ?? {}).map((quota) => quota?.resetAt),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value > now.getTime());
  return values.length ? Math.min(...values) : 0;
}

export function selectAutoSwitchCandidate<
  TProfile extends GenericProfileRecord,
  TScope extends string,
>(
  state: GenericProfileState<TProfile>,
  options: AutoSwitchSelectionOptions<TScope>,
): TProfile | undefined {
  const now = options.now ?? new Date();
  const activeIndex = state.activeProfile
    ? state.profiles.findIndex(({ name }) => name === state.activeProfile)
    : -1;
  const unknownScope = options.unknownScope ?? ("unknown" as TScope);
  const targetScopes = options.triggerScope === unknownScope
    ? options.switchableScopes
    : [options.triggerScope];

  return state.profiles
    .map((profile, index) => {
      if (profile.name === state.activeProfile) return undefined;
      if (!baseProfileSelectable(profile, options.allowIneligibleActivation ?? true)) return undefined;
      const blocked = options.candidateQuotaPolicy === "any-scope"
        ? profileWideQuotaActive(profile, options) || hasAnySwitchableQuota(profile, options)
        : targetScopes.some((scope) => isProfileScopeExhausted(profile, scope, options));
      if (blocked) return undefined;
      const category = options.mode === "all-scopes" && hasAnySwitchableQuota(profile, options)
        ? 1
        : 0;
      const offset = activeIndex < 0
        ? index
        : (index - activeIndex + state.profiles.length) % state.profiles.length;
      return {
        profile,
        category,
        resetAt: earliestActiveQuotaReset(profile, now),
        offset,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) =>
      left.category - right.category
      || left.resetAt - right.resetAt
      || left.offset - right.offset
    )[0]?.profile;
}

export type CandidateQuotaVerificationStatus = "available" | "exhausted" | "failed";

export interface CandidateQuotaVerification {
  profileName: string;
  status: CandidateQuotaVerificationStatus;
  reason?: string;
}

export interface VerifiedAutoSwitchCandidateDecision<TProfile extends GenericProfileRecord> {
  profile?: TProfile;
  reason: "verified_available" | "all_verified_exhausted" | "candidate_verification_failed";
  failedProfiles: string[];
}

/**
 * Selects an automatic failover target only from the results of the current
 * isolated verification round. Persisted quota fields are intentionally not
 * consulted: they are presentation/cache data and cannot veto a live-verified
 * candidate or authorize an unverified one. A successful isolated status probe
 * also overrides older disabled/credential markers for this selection round.
 */
export function selectVerifiedAutoSwitchCandidate<
  TProfile extends GenericProfileRecord,
>(
  state: GenericProfileState<TProfile>,
  verifications: readonly CandidateQuotaVerification[],
): VerifiedAutoSwitchCandidateDecision<TProfile> {
  const byProfile = new Map(verifications.map((result) => [result.profileName, result]));
  const candidates = state.profiles.filter((profile) => profile.name !== state.activeProfile);
  const failedProfiles = candidates
    .filter((profile) => byProfile.get(profile.name)?.status !== "available"
      && byProfile.get(profile.name)?.status !== "exhausted")
    .map((profile) => profile.name);
  const profile = selectRoundRobinProfile(state, (candidate) =>
    byProfile.get(candidate.name)?.status === "available"
  );
  if (profile) return { profile, reason: "verified_available", failedProfiles };
  if (failedProfiles.length) {
    return { reason: "candidate_verification_failed", failedProfiles };
  }
  return { reason: "all_verified_exhausted", failedProfiles };
}

export function selectRoundRobinProfile<TProfile extends GenericProfileRecord>(
  state: GenericProfileState<TProfile>,
  selectable: (profile: TProfile) => boolean,
): TProfile | undefined {
  if (!state.profiles.length) return undefined;
  const activeIndex = state.activeProfile
    ? state.profiles.findIndex(({ name }) => name === state.activeProfile)
    : -1;
  const candidateCount = activeIndex < 0 ? state.profiles.length : state.profiles.length - 1;
  for (let step = 1; step <= candidateCount; step += 1) {
    const profile = state.profiles[(activeIndex + step + state.profiles.length) % state.profiles.length]!;
    if (selectable(profile)) return profile;
  }
  return undefined;
}

export interface GenericProfileState<TProfile extends GenericProfileRecord> {
  activeProfile?: string;
  profiles: TProfile[];
}

export function validateProfileName(input: unknown): string {
  const name = String(input ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error("Profile names must be 1-64 chars: letters, numbers, dot, underscore, dash.");
  }
  return name;
}

export function profileNameFromIdentity(identity: unknown): string {
  const source = String(identity ?? "").split("@")[0] ?? "";
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[._-]{2,}/g, "-")
    .slice(0, 64);
  return validateProfileName(normalized || "account");
}

export function uniqueProfileName<TProfile extends GenericProfileRecord>(
  baseName: string,
  state: GenericProfileState<TProfile>,
  options: { aliases?: (profile: TProfile) => readonly string[] | undefined } = {},
): string {
  const base = validateProfileName(baseName);
  const names = new Set(
    state.profiles.flatMap((profile) => [
      profile.name,
      ...(options.aliases?.(profile) ?? []),
    ]),
  );
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base.slice(0, Math.max(1, 64 - String(suffix).length - 1))}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused profile name for '${base}'.`);
}

export function clearExpiredProfileQuota<TProfile extends GenericProfileRecord>(
  profile: TProfile,
  now = new Date(),
): void {
  if (
    profile.quotaStatus === "exhausted"
    && profile.quotaResetAt
    && Date.parse(profile.quotaResetAt) <= now.getTime()
  ) {
    profile.quotaStatus = "available";
    profile.quotaResetAt = undefined;
    profile.lastQuotaReason = undefined;
  }
}

export function markActiveProfile<TProfile extends GenericProfileRecord>(
  state: GenericProfileState<TProfile>,
  name: string,
  options: { now?: Date; incrementSelection?: boolean } = {},
): TProfile {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) throw new Error(`Profile not found: ${name}`);
  const now = options.now ?? new Date();
  const nowString = now.toISOString();
  state.activeProfile = name;
  profile.lastActivatedAt = nowString;
  profile.updatedAt = nowString;
  if (options.incrementSelection ?? true) {
    profile.selectionCount = (profile.selectionCount ?? 0) + 1;
  }
  clearExpiredProfileQuota(profile, now);
  return profile;
}

export interface NativeSupervisorHostStatus {
  supported: boolean;
  platform: string;
  arch: string;
  expected: string;
  binaryName?: string;
  message?: string;
}

export function nativeSupervisorBinaryName(
  binariesByHost: Readonly<Record<string, string>>,
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  return binariesByHost[`${platform}:${arch}`];
}

export function nativeSupervisorHostStatus(
  productName: string,
  binariesByHost: Readonly<Record<string, string>>,
  expected: string,
  platform = process.platform,
  arch = process.arch,
): NativeSupervisorHostStatus {
  const binaryName = nativeSupervisorBinaryName(binariesByHost, platform, arch);
  const supported = Boolean(binaryName);
  return {
    supported,
    platform,
    arch,
    expected,
    binaryName,
    message: supported
      ? undefined
      : `${productName} native supervisor supports ${expected} only; current host is ${platform}/${arch}.`,
  };
}

export function relativeTime(value: string | undefined, now = new Date()): string {
  if (!value) return "-";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "-";
  const delta = timestamp - now.getTime();
  const absolute = Math.abs(delta);
  const units: Array<[number, string]> = [
    [24 * 60 * 60 * 1000, "d"],
    [60 * 60 * 1000, "h"],
    [60 * 1000, "m"],
    [1000, "s"],
  ];
  const [unitMs, suffix] = units.find(([ms]) => absolute >= ms) ?? units.at(-1)!;
  const amount = Math.max(1, Math.round(absolute / unitMs));
  return delta >= 0 ? `in ${amount}${suffix}` : `${amount}${suffix} ago`;
}

export * from "./profile_ui.js";

export interface RestartNoticeOptions {
  productName: string;
  sessionCount: number;
}

export function profileSwitchRestartNotice(options: RestartNoticeOptions): string | undefined {
  if (options.sessionCount <= 0) return undefined;
  const noun = options.sessionCount === 1 ? "session" : "sessions";
  return `[${options.productName}] Profile switch will restart ${options.sessionCount} supervised ${noun}.`;
}
