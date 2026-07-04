import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexHome, configDir } from "./config.js";
import { findRealCodex } from "./processes.js";

const CONTROL_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]/g;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function stripTerminalControl(text) {
  return text.replace(CONTROL_RE, "").replaceAll("\r", "\n");
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function parseMonth(value) {
  return {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  }[String(value).toLowerCase()];
}

export function parseStatusReset(resetText, nowMs = Date.now()) {
  if (!resetText) return undefined;
  const text = resetText.trim();
  const now = new Date(nowMs);

  const timeOnly = text.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnly) {
    const candidate = new Date(now);
    candidate.setHours(Number(timeOnly[1]), Number(timeOnly[2]), 0, 0);
    if (candidate.getTime() + 60000 < nowMs) candidate.setDate(candidate.getDate() + 1);
    return candidate.toISOString();
  }

  const dateTime = text.match(/^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]+)$/i);
  if (dateTime) {
    const month = parseMonth(dateTime[4]);
    if (month === undefined) return undefined;
    const candidate = new Date(
      now.getFullYear(),
      month,
      Number(dateTime[3]),
      Number(dateTime[1]),
      Number(dateTime[2]),
      0,
      0,
    );
    if (candidate.getTime() + 7 * 86400000 < nowMs) candidate.setFullYear(candidate.getFullYear() + 1);
    return candidate.toISOString();
  }

  return undefined;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLimit(lines, text, label, nowMs) {
  const index = lines.findIndex((line) => line.toLowerCase().includes(`${label.toLowerCase()} limit:`));
  if (index >= 0) {
    const percentLine = lines[index];
    const percent = percentLine.match(/(\d+(?:\.\d+)?)%\s+left/i);
    if (percent) {
      const segment = lines.slice(index, index + 3).join(" ");
      const reset = segment.match(/\(resets\s+([^)]+)\)/i);
      const remainingPercent = clampPercent(Number(percent[1]));
      return {
        remainingPercent,
        usedPercent: remainingPercent === undefined ? undefined : clampPercent(100 - remainingPercent),
        resetText: reset?.[1],
        resetAt: parseStatusReset(reset?.[1], nowMs),
      };
    }
  }

  const labelPattern = escapeRegex(label);
  const percent = text.match(new RegExp(`${labelPattern}\\s+limit:[\\s\\S]{0,400}?(\\d+(?:\\.\\d+)?)%\\s+left`, "i"));
  if (!percent) return undefined;
  const resetSegment = text.slice(percent.index ?? 0, (percent.index ?? 0) + 600);
  const reset = resetSegment.match(/\(resets\s+([^)]+)\)/i);
  const remainingPercent = clampPercent(Number(percent[1]));
  return {
    remainingPercent,
    usedPercent: remainingPercent === undefined ? undefined : clampPercent(100 - remainingPercent),
    resetText: reset?.[1],
    resetAt: parseStatusReset(reset?.[1], nowMs),
  };
}

export function parseCodexStatusOutput(output, nowMs = Date.now()) {
  const text = stripTerminalControl(output);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const account = text.match(/Account:\s*([^\n(]+?)\s*\(([^)\n]+)\)/i)
    ?? text.match(/Account:\s*([^\n]+?)(?:\n|5h\s+limit|$)/i);
  const primary = parseLimit(lines, text, "5h", nowMs);
  const secondary = parseLimit(lines, text, "Weekly", nowMs);

  if (!primary && !secondary) return undefined;
  return {
    source: "status",
    account: account?.[1]?.trim(),
    planType: account?.[2]?.trim()?.toLowerCase(),
    limits: {
      primary,
      secondary,
    },
    raw: text,
  };
}

async function copyIfPresent(source, target) {
  try {
    const info = await stat(source);
    if (!info.isFile()) return;
    await copyFile(source, target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function prepareProbeHome(sourceHome) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const probeHome = await mkdtemp(join(configDir, "status-probe-"));
  await copyIfPresent(join(sourceHome, "auth.json"), join(probeHome, "auth.json"));
  await copyIfPresent(join(sourceHome, "config.toml"), join(probeHome, "config.toml"));
  return probeHome;
}

function runScriptAttempt(args, env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 40000;
  const confirmDelayMs = options.confirmDelayMs ?? 1000;
  const commandDelayMs = options.commandDelayMs ?? 10000;
  const commandRepeatMs = options.commandRepeatMs ?? 5000;
  const commandRepeats = options.commandRepeats ?? 4;
  const stopDelayMs = options.stopDelayMs ?? 34000;

  return new Promise((resolve, reject) => {
    const child = spawn("script", args, { stdio: ["pipe", "pipe", "pipe"], env });
    let output = "";
    let settled = false;
    const timers = [];

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(result);
    };
    const safeWrite = (value, end = false) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) return;
      child.stdin.write(value, () => undefined);
      if (end && !child.stdin.writableEnded) child.stdin.end();
    };

    const appendOutput = (chunk) => {
      output += chunk.toString("utf8");
      const clean = stripTerminalControl(output);
      if (/5h\s+limit:/i.test(clean) && /weekly\s+limit:/i.test(clean)) {
        timers.push(setTimeout(() => {
          safeWrite("\x03", true);
        }, 500));
      }
    };

    child.stdin.on("error", () => undefined);
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      finish(undefined, { code, output });
    });

    timers.push(setTimeout(() => {
      safeWrite("\r");
    }, confirmDelayMs));
    for (let index = 0; index < commandRepeats; index += 1) {
      timers.push(setTimeout(() => {
        safeWrite("/status\r");
      }, commandDelayMs + index * commandRepeatMs));
    }
    timers.push(setTimeout(() => {
      safeWrite("\x03", true);
    }, stopDelayMs));
    timers.push(setTimeout(() => {
      finish(new Error("codex /status probe timed out"));
    }, timeoutMs));
  });
}

async function runCodexStatusInPty(realCodex, probeHome, options = {}) {
  const command = [
    "stty cols 120 rows 40 >/dev/null 2>&1;",
    "env",
    `CODEX_HOME=${shellQuote(probeHome)}`,
    "COLUMNS=120",
    "LINES=40",
    shellQuote(realCodex),
    "--no-alt-screen",
    "--dangerously-bypass-approvals-and-sandbox",
  ].join(" ");
  const env = {
    ...process.env,
    CODEX_HOME: probeHome,
    TERM: !process.env.TERM || process.env.TERM === "dumb" ? "xterm-256color" : process.env.TERM,
  };
  const attempts = [
    ["-q", "-c", command, "/dev/null"],
    ["-q", "/dev/null", "/bin/sh", "-lc", command],
  ];
  let lastError;
  for (const args of attempts) {
    try {
      const result = await runScriptAttempt(args, env, options);
      const parsed = parseCodexStatusOutput(result.output, options.nowMs);
      if (parsed) return parsed;
      lastError = new Error("codex /status output did not include quota limits");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("codex /status probe failed");
}

export async function probeCodexStatusQuota(options = {}) {
  const home = options.codexHome ?? codexHome;
  const realCodex = options.realCodex ?? await findRealCodex();
  const probeHome = options.probeHome ?? await prepareProbeHome(home);
  const ownsProbeHome = !options.probeHome;
  try {
    return await runCodexStatusInPty(realCodex, probeHome, options);
  } finally {
    if (ownsProbeHome) await rm(probeHome, { recursive: true, force: true });
  }
}
