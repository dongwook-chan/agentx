import { open, stat } from "node:fs/promises";
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
}

export interface AgentCliManifest {
  id: "agy" | "codex";
  packageName: string;
  executable: string;
  login: LoginSemantics;
  credentials: CredentialSemantics;
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

export interface SessionControlAdapter<TRecord extends ManagedSessionRecord> {
  sessionRecords(): Promise<TRecord[]>;
  pause(record: TRecord): Promise<TRecord>;
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

export async function runAuthSwitchTransaction<TRecord extends ManagedSessionRecord, TResult>(
  adapter: AuthSwitchTransactionAdapter<TRecord>,
  operation: () => Promise<TResult>,
  options: { resume?: boolean } = {},
): Promise<TResult> {
  const run = async (): Promise<TResult> => {
    const records = await pauseAllSessions(adapter.sessionControl);
    try {
      return await operation();
    } finally {
      if (options.resume ?? true) {
        await resumeAllSessions(adapter.sessionControl, records);
      }
    }
  };
  return adapter.withLock ? await adapter.withLock(run) : await run();
}

export type UsageCheckReason =
  | "explicit-scan"
  | "manual-record"
  | "live-quota-trigger"
  | "session-exit"
  | "list"
  | "use";

export type UsageCheckMode = "refresh" | "local-scan" | "state-only";

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

export interface UsageRefreshAdapter<TSnapshot extends UsageSnapshot = UsageSnapshot> {
  refreshUsage(reason: UsageCheckReason): Promise<TSnapshot | undefined>;
  scanLocalUsage?(reason: UsageCheckReason): Promise<TSnapshot | undefined>;
}

export function usageCheckMode(reason: UsageCheckReason): UsageCheckMode {
  switch (reason) {
    case "explicit-scan":
    case "manual-record":
    case "live-quota-trigger":
      return "refresh";
    case "session-exit":
      return "local-scan";
    case "list":
    case "use":
      return "state-only";
  }
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

export const agentProfileTableHeaders = [
  "",
  "#",
  "name",
  "expected-email",
  "actual-email",
  "status",
  "quota-reset",
  "last-request",
  "activated",
  "verified",
  "switches",
] as const;

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

export interface RestartNoticeOptions {
  productName: string;
  sessionCount: number;
}

export function profileSwitchRestartNotice(options: RestartNoticeOptions): string | undefined {
  if (options.sessionCount <= 0) return undefined;
  const noun = options.sessionCount === 1 ? "session" : "sessions";
  return `[${options.productName}] Profile switch will restart ${options.sessionCount} supervised ${noun}.`;
}
