import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { refreshActiveProfileCredential } from "./auth.js";
import { ensureConfig, loadState, saveState } from "./config.js";
import { decideCodexFailover } from "./failover_policy.js";
import { buildCodexLaunchArgsFromState } from "./launch_args.js";
import { cleanupRuntimeFile, runtimeRecordPath, runtimeSocketPath, writeRuntimeRecord } from "./managed_sessions.js";
import { runNativeSupervisor } from "./native.js";
import { findRealCodex, isInteractiveCodex } from "./processes.js";
import { QuotaTail, wait } from "./quota_tail.js";
import { recordQuotaForProfile, scanCodexQuota } from "./quota.js";
import {
  findMatchingSession,
  findSessionById,
  snapshotSessionFiles,
  waitForSessionFileChange,
} from "./session_match.js";
export { pickNextProfile } from "./selection.js";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function spawnCodex(command, args) {
  const child = spawn(command, args, { stdio: "inherit", cwd: process.cwd(), env: process.env });
  const exit = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  return { child, exit };
}

async function saveMatchedSession(matchedSession) {
  if (!matchedSession?.sessionId) return;
  const state = await loadState();
  state.lastSession = {
    sessionId: matchedSession.sessionId,
    file: matchedSession.file,
    timestamp: matchedSession.timestamp,
    cwd: matchedSession.cwd,
    matchedAt: new Date().toISOString(),
  };
  const active = state.profiles.find((profile) => profile.name === state.activeProfile);
  if (active) active.lastSession = state.lastSession;
  await saveState(state);
}

function describeReset(profile) {
  return profile.quotaResetAt ? `; reset at ${profile.quotaResetAt}` : "";
}

function stopChildForFailover(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5000).unref();
}

async function effectiveLiveQuotaSummary(summary) {
  if (!summary?.exhausted && !summary?.quotaTrigger) return summary;
  const statusSummary = await scanCodexQuota({ sinceMs: Date.now() - 60000, reason: "live-quota-trigger" });
  if (statusSummary?.exhausted) return statusSummary;
  if (summary.exhausted) return summary;
  return {
    ...summary,
    source: "live-trigger",
    exhausted: true,
    historicalExhausted: true,
    exhaustedEvents: Math.max(1, summary.exhaustedEvents ?? 0),
    reason: summary.quotaTrigger?.reason ?? "usage limit reached",
    lastAt: summary.quotaTrigger?.timestamp ?? summary.lastAt ?? new Date().toISOString(),
    current: summary.current ?? {
      file: undefined,
      line: undefined,
      timestamp: summary.quotaTrigger?.timestamp ?? new Date().toISOString(),
      primary: undefined,
      secondary: undefined,
      reachedType: "usage_limit_message",
      resetAt: undefined,
      credits: undefined,
      planType: summary.planType,
    },
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

function writeJSON(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`);
}

function requestedResumeSessionId(args) {
  const resumeIndex = args.indexOf("resume");
  if (resumeIndex < 0) return undefined;
  for (const arg of args.slice(resumeIndex + 1)) {
    if (arg.startsWith("-")) continue;
    if (SESSION_ID_RE.test(arg)) return arg;
    return undefined;
  }
  return undefined;
}

async function monitorMatchedSession(matchedSession, child, profileName, signal) {
  if (!matchedSession?.file) return undefined;
  const tail = new QuotaTail(matchedSession.file, {
    offset: Math.max(0, matchedSession.previousSize ?? 0),
  });
  while (!signal.aborted) {
    const summary = await tail.readAdded();
    if (summary?.tokenCountRecords) {
      const effectiveSummary = await effectiveLiveQuotaSummary(summary);
      const profile = await recordQuotaForProfile(effectiveSummary, profileName);
      if (profile?.quotaStatus === "exhausted") {
        console.error(`[cdxx] Profile '${profile.name}' reached quota${describeReset(profile)}.`);
        const action = await decideCodexFailover({
          profileName: profile.name,
          sessionId: matchedSession.sessionId,
          summary: effectiveSummary,
        });
        if (action.message) console.error(action.message);
        if (action.kind === "switch_and_resume" && action.profile && matchedSession.sessionId) {
          stopChildForFailover(child);
          return {
            sessionId: matchedSession.sessionId,
            fromProfile: profile.name,
            toProfile: action.profile,
          };
        }
        return undefined;
      }
    } else if (summary?.quotaTrigger) {
      const effectiveSummary = await effectiveLiveQuotaSummary(summary);
      const profile = await recordQuotaForProfile(effectiveSummary, profileName);
      if (profile?.quotaStatus === "exhausted") {
        console.error(`[cdxx] Profile '${profile.name}' reached quota${describeReset(profile)}.`);
        const action = await decideCodexFailover({
          profileName: profile.name,
          sessionId: matchedSession.sessionId,
          summary: effectiveSummary,
        });
        if (action.message) console.error(action.message);
        if (action.kind === "switch_and_resume" && action.profile && matchedSession.sessionId) {
          stopChildForFailover(child);
          return {
            sessionId: matchedSession.sessionId,
            fromProfile: profile.name,
            toProfile: action.profile,
          };
        }
        return undefined;
      }
    }
    await wait(500, signal);
  }
  return undefined;
}

export async function runCodexSession(args) {
  const realCodex = await findRealCodex();
  try {
    const nativeCode = await runNativeSupervisor(args, realCodex);
    if (nativeCode !== undefined) return nativeCode;
  } catch (error) {
    if (process.env.CDXX_REQUIRE_NATIVE_SUPERVISOR === "1") throw error;
    console.error(`[cdxx] Native supervisor failed; falling back to Node supervisor. (${error.message})`);
  }
  if (!isInteractiveCodex(args)) {
    return await spawnCodex(realCodex, args).exit;
  }

  await ensureConfig();
  const id = randomUUID();
  const socketPath = runtimeSocketPath();
  const recordPath = runtimeRecordPath(id);
  const startedAt = new Date().toISOString();
  let currentArgs = args;
  let attempts = 0;
  let child;
  let paused = false;
  let pauseRequested = false;
  let resumePending = false;
  let activeMatchedSession;
  let lastSessionId;
  let resumeRequested;

  const currentRecord = () => ({
    id,
    pid: process.pid,
    childPid: child?.pid,
    cwd: process.cwd(),
    args: currentArgs,
    codexSessionId: activeMatchedSession?.sessionId ?? lastSessionId,
    socketPath,
    paused,
    restartable: true,
    startedAt,
  });

  const persist = async () => {
    await writeRuntimeRecord(recordPath, currentRecord());
  };

  const waitForResume = async () => {
    if (!paused) return;
    if (resumePending) {
      resumePending = false;
      paused = false;
      return;
    }
    await new Promise((resolve) => {
      resumeRequested = () => {
        resumePending = false;
        resolve();
      };
    });
  };

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("end", async () => {
      try {
        const request = JSON.parse(input);
        if (request.command === "pause") {
          paused = true;
          pauseRequested = true;
          resumePending = false;
          await stopChild(child);
          child = undefined;
          await persist();
          writeJSON(socket, { ok: true, record: currentRecord() });
        } else if (request.command === "resume") {
          paused = false;
          resumePending = true;
          const resolve = resumeRequested;
          resumeRequested = undefined;
          if (resolve) resolve();
          await persist();
          writeJSON(socket, { ok: true });
        } else {
          await persist();
          writeJSON(socket, { ok: true, record: currentRecord() });
        }
      } catch (error) {
        writeJSON(socket, { ok: false, error: error.message });
      }
    });
  });

  await cleanupRuntimeFile(socketPath);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    for (;;) {
      const started = Date.now();
      const profileName = (await loadState()).activeProfile;
      const before = await snapshotSessionFiles();
      const launchArgs = await buildCodexLaunchArgsFromState(currentArgs);
      const spawned = spawnCodex(realCodex, launchArgs);
      child = spawned.child;
      pauseRequested = false;
      resumePending = false;
      activeMatchedSession = undefined;
      await persist();

      const matchAbort = new AbortController();
      const monitorAbort = new AbortController();
      let matchedSession;
      let monitorPromise;
      let failover;
      const warnedSessionFormatFiles = new Set();
      const onFormatError = (message) => {
        const file = message.match(/first line of (.+?) is/)?.[1];
        const key = file ?? message;
        if (warnedSessionFormatFiles.has(key)) return;
        warnedSessionFormatFiles.add(key);
        console.error(message);
      };
      const attachMatch = async (match) => {
        matchedSession = match;
        activeMatchedSession = match;
        await saveMatchedSession(match);
        if (match?.sessionId) lastSessionId = match.sessionId;
        await persist();
        if (match?.file) {
          monitorPromise = monitorMatchedSession(match, child, profileName, monitorAbort.signal).then((result) => {
            failover = result;
            return result;
          });
        }
        return match;
      };

      const matchPromise = (async () => {
        const resumeSessionId = requestedResumeSessionId(currentArgs);
        let match = resumeSessionId
          ? await findSessionById(resumeSessionId, { before, onFormatError })
          : await findMatchingSession({
            before,
            cwd: process.cwd(),
            startMs: started,
            onFormatError,
          });
        if (match?.sessionId) return await attachMatch(match);

        await waitForSessionFileChange({
          before,
          signal: matchAbort.signal,
        });
        if (matchAbort.signal.aborted) return undefined;
        await wait(100, matchAbort.signal);
        if (matchAbort.signal.aborted) return undefined;

        match = resumeSessionId
          ? await findSessionById(resumeSessionId, { before, onFormatError })
          : await findMatchingSession({
            before,
            cwd: process.cwd(),
            startMs: started,
            onFormatError,
          });
        if (match?.sessionId) return await attachMatch(match);
        return undefined;
      })().catch(() => undefined);

      const code = await spawned.exit;
      child = undefined;
      matchAbort.abort();
      monitorAbort.abort();
      await matchPromise.catch(() => undefined);
      if (monitorPromise) await monitorPromise.catch(() => undefined);

      matchedSession = await findMatchingSession({
        before,
        cwd: process.cwd(),
        startMs: started,
      }).catch(() => matchedSession);
      activeMatchedSession = matchedSession;
      await saveMatchedSession(matchedSession);
      if (matchedSession?.sessionId) lastSessionId = matchedSession.sessionId;

      await refreshActiveProfileCredential();

      await persist();

      if (pauseRequested || paused) {
        if (matchedSession?.sessionId) currentArgs = ["resume", matchedSession.sessionId];
        await persist();
        await waitForResume();
        pauseRequested = false;
        resumePending = false;
        continue;
      }

      if (!failover) return code;
      attempts += 1;
      if (attempts > 10) {
        console.error("[cdxx] Stopping after 10 quota failover attempts.");
        return code;
      }
      currentArgs = ["resume", failover.sessionId];
    }
  } finally {
    await stopChild(child);
    server.close();
    await cleanupRuntimeFile(socketPath);
    await cleanupRuntimeFile(recordPath);
  }
}

export async function codexAuthExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
