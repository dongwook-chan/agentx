import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { join, resolve } from "node:path";
import {
  cleanupRuntimeFile,
  ensureDirectories,
  loadState,
  logDir,
  recordProfileQuotaAvailable,
  recordProfileQuotaExhausted,
  runtimeDir,
} from "./config.js";
import { buildAgyLaunchArgs } from "./launch_args.js";
import { findRealAgy } from "./processes.js";
import {
  parseUsageTranscriptAggregates,
  QuotaScope,
  UsageScopeAggregate,
} from "./quota.js";

interface ProbeCommand {
  command: string;
  args: string[];
  input?: string;
}

export interface UsageProbeOptions {
  profileName?: string;
  realAgy?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface UsageProbeResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  profileName?: string;
  aggregates: UsageScopeAggregate[];
  exhaustedScopes: QuotaScope[];
  error?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findScriptExecutable(): Promise<string | undefined> {
  for (const candidate of ["/usr/bin/script", "/bin/script"]) {
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

async function findExpectExecutable(): Promise<string | undefined> {
  const candidates = [
    "/usr/bin/expect",
    "/opt/homebrew/bin/expect",
    ...((process.env.PATH ?? "").split(delimiter).map((directory) => resolve(directory, "expect"))),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

function usageProbeExpectCommand(
  expect: string,
  realAgy: string,
  launchArgs: string[],
  transcriptPath: string,
): ProbeCommand {
  const script = `
log_user 1
set transcript [lindex $argv 0]
log_file -noappend $transcript
set timeout 12
spawn {*}[lrange $argv 1 end]
catch {stty rows 40 columns 120 < $spawn_out(slave,name)}
set timeout 1
expect { timeout {} eof {} }
send "\\r"
set timeout 4
expect {
  -re {for shortcuts|>} {}
  timeout {}
  eof {}
}
set saw_usage 0
send "\\025/usage\\r"
set timeout 3
expect {
  -re {Models[[:space:]]*&[[:space:]]*Quota} { set saw_usage 1 }
  timeout {}
  eof {}
}
if {$saw_usage == 0} {
  send "\\025/usage\\r"
  set timeout 3
  expect {
    -re {Models[[:space:]]*&[[:space:]]*Quota} { set saw_usage 1 }
    timeout {}
    eof {}
  }
}
if {$saw_usage == 0} {
  send "\\025/usage\\r"
  set timeout 2
  expect {
    -re {Models[[:space:]]*&[[:space:]]*Quota} { set saw_usage 1 }
    timeout {}
    eof {}
  }
}
if {$saw_usage == 1} {
  set timeout 2
  expect {
    -re {esc to cancel|press ctrl\\+c|Claude Opus|Quota exhausted} {}
    timeout {}
    eof {}
  }
}
send "\\033\\003\\003"
set timeout 1
expect { timeout {} eof {} }
catch {close}
catch {expect eof}
`;
  return {
    command: expect,
    args: ["-f", "-", transcriptPath, realAgy, ...launchArgs],
    input: script,
  };
}

function usageProbeScriptCommand(
  script: string,
  realAgy: string,
  launchArgs: string[],
  transcriptPath: string,
): ProbeCommand {
  const input = [
    "sleep 0.8; printf '\\r'",
    "sleep 1.8; printf '/usage\\r'",
    "sleep 2.6; printf '\\025/usage\\r'",
    "sleep 2.4; printf '\\025/usage\\r'",
    "sleep 1.2; printf '\\033\\003\\003'",
  ].join("; ");
  if (process.platform === "linux") {
    const command = [realAgy, ...launchArgs].map(shellQuote).join(" ");
    return {
      command: "/bin/sh",
      args: ["-c", `(${input}) | ${shellQuote(script)} -q -f -c ${shellQuote(command)} ${
        shellQuote(transcriptPath)
      } >/dev/null 2>/dev/null`],
    };
  }
  const args = [script, "-q", transcriptPath, realAgy, ...launchArgs].map(shellQuote).join(" ");
  return {
    command: "/bin/sh",
    args: ["-c", `(${input}) | ${args} >/dev/null 2>/dev/null`],
  };
}

async function readTranscript(path: string): Promise<string> {
  return await readFile(path, "utf8").catch(() => "");
}

function terminateProbeProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill(signal); }
      catch { /* The process may have exited between checks. */ }
    }
  }
}

async function captureUsageTranscript(options: {
  realAgy: string;
  cwd: string;
  transcriptPath: string;
  logPath: string;
  timeoutMs: number;
}): Promise<string> {
  const state = await loadState();
  const launchArgs = buildAgyLaunchArgs([], { logPath: options.logPath, state });
  const expect = await findExpectExecutable();
  const script = expect ? undefined : await findScriptExecutable();
  if (!expect && !script) return "";
  const command = expect
    ? usageProbeExpectCommand(expect, options.realAgy, launchArgs, options.transcriptPath)
    : usageProbeScriptCommand(script!, options.realAgy, launchArgs, options.transcriptPath);

  await new Promise<void>((resolvePromise) => {
    const child = spawn(command.command, command.args, {
      cwd: options.cwd,
      detached: true,
      stdio: command.input ? ["pipe", "ignore", "ignore"] : "ignore",
      env: {
        ...process.env,
        AGYX_USAGE_PROBE: "1",
        TERM: process.env.TERM || "xterm-256color",
        COLUMNS: process.env.COLUMNS || "120",
        LINES: process.env.LINES || "40",
      },
    });
    if (command.input && child.stdin) child.stdin.end(command.input);

    let killDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      terminateProbeProcessGroup(child, "SIGTERM");
      killDeadline = setTimeout(() => {
        terminateProbeProcessGroup(child, "SIGKILL");
      }, 2000);
    }, options.timeoutMs);

    const cleanup = (): void => {
      clearTimeout(deadline);
      if (killDeadline) clearTimeout(killDeadline);
    };

    child.on("error", () => {
      cleanup();
      resolvePromise();
    });
    child.on("close", () => {
      cleanup();
      resolvePromise();
    });
  });

  return await readTranscript(options.transcriptPath);
}

async function recordUsageAggregates(
  profileName: string,
  aggregates: UsageScopeAggregate[],
): Promise<QuotaScope[]> {
  const exhaustedScopes: QuotaScope[] = [];
  for (const aggregate of aggregates) {
    if (aggregate.status === "available") {
      await recordProfileQuotaAvailable(profileName, aggregate.scope);
      continue;
    }
    await recordProfileQuotaExhausted(profileName, {
      reason: aggregate.reason ?? "usage quota exhausted",
      resetAt: aggregate.resetAt,
      scope: aggregate.scope,
      modelLabel: aggregate.modelLabel,
    });
    exhaustedScopes.push(aggregate.scope);
  }
  return exhaustedScopes;
}

export async function runUsageProbe(options: UsageProbeOptions = {}): Promise<UsageProbeResult> {
  try {
    await ensureDirectories();
    const state = await loadState();
    const profileName = options.profileName ?? state.activeProfile;
    if (!profileName) {
      return {
        ok: true,
        skipped: true,
        reason: "no active profile",
        aggregates: [],
        exhaustedScopes: [],
      };
    }

    const realAgy = options.realAgy ?? await findRealAgy();
    const cwd = options.cwd ?? process.cwd();
    const id = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const transcriptPath = join(runtimeDir, `${id}.usage-probe.terminal.log`);
    const logPath = join(logDir, `usage-probe-${id}.log`);
    try {
      const transcript = await captureUsageTranscript({
        realAgy,
        cwd,
        transcriptPath,
        logPath,
        timeoutMs: options.timeoutMs ?? 15000,
      });
      const aggregates = parseUsageTranscriptAggregates(transcript);
      const exhaustedScopes = await recordUsageAggregates(profileName, aggregates);
      return {
        ok: true,
        profileName,
        aggregates,
        exhaustedScopes,
      };
    } finally {
      if (process.env.AGYX_KEEP_USAGE_PROBE_LOGS !== "1") {
        await cleanupRuntimeFile(transcriptPath);
        await cleanupRuntimeFile(logPath);
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
      aggregates: [],
      exhaustedScopes: [],
    };
  }
}
