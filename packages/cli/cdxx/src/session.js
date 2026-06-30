import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { refreshActiveProfileCredential } from "./auth.js";
import { loadState, saveState } from "./config.js";
import { decideCodexFailover } from "./failover_policy.js";
import { buildCodexLaunchArgsFromState } from "./launch_args.js";
import { runNativeSupervisor } from "./native.js";
import { findRealCodex, isInteractiveCodex } from "./processes.js";
import { QuotaTail, wait } from "./quota_tail.js";
import { recordQuotaForProfile, scanCodexSessions } from "./quota.js";
import { snapshotSessionFiles, waitForMatchingSession, findMatchingSession } from "./session_match.js";
export { pickNextProfile } from "./selection.js";

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

async function monitorMatchedSession(matchedSession, child, profileName, signal) {
  if (!matchedSession?.file) return undefined;
  const tail = new QuotaTail(matchedSession.file, {
    offset: Math.max(0, matchedSession.previousSize ?? 0),
  });
  while (!signal.aborted) {
    const summary = await tail.readAdded();
    if (summary?.tokenCountRecords) {
      const profile = await recordQuotaForProfile(summary, profileName);
      if (profile?.quotaStatus === "exhausted") {
        console.error(`[cdxx] Profile '${profile.name}' reached quota${describeReset(profile)}.`);
        const action = await decideCodexFailover({
          profileName: profile.name,
          sessionId: matchedSession.sessionId,
          summary,
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

async function runCodexOnce(realCodex, args) {
  const started = Date.now();
  const profileName = (await loadState()).activeProfile;
  const before = await snapshotSessionFiles();
  const launchArgs = await buildCodexLaunchArgsFromState(args);
  const { child, exit } = spawnCodex(realCodex, launchArgs);
  const matchAbort = new AbortController();
  const monitorAbort = new AbortController();
  let matchedSession;
  let monitorPromise;
  let failover;

  const matchPromise = waitForMatchingSession({
    before,
    cwd: process.cwd(),
    startMs: started,
    timeoutMs: 30000,
    signal: matchAbort.signal,
  }).then(async (match) => {
    matchedSession = match;
    await saveMatchedSession(match);
    if (match?.file) {
      monitorPromise = monitorMatchedSession(match, child, profileName, monitorAbort.signal).then((result) => {
        failover = result;
        return result;
      });
    }
    return match;
  }).catch(() => undefined);

  const code = await exit;
  matchAbort.abort();
  monitorAbort.abort();
  await matchPromise.catch(() => undefined);
  if (monitorPromise) await monitorPromise.catch(() => undefined);

  matchedSession = await findMatchingSession({
    before,
    cwd: process.cwd(),
    startMs: started,
  }).catch(() => matchedSession);
  await saveMatchedSession(matchedSession);

  await refreshActiveProfileCredential();
  const summary = await scanCodexSessions({ sinceMs: started - 5000 });
  const profile = await recordQuotaForProfile(summary, profileName);
  if (!failover && profile?.quotaStatus === "exhausted") {
    console.error(`[cdxx] Profile '${profile.name}' reached quota${describeReset(profile)}.`);
    const action = await decideCodexFailover({
      profileName: profile.name,
      sessionId: matchedSession?.sessionId,
      summary,
    });
    if (action.message) console.error(action.message);
    if (action.kind === "switch_and_resume" && action.profile && matchedSession?.sessionId) {
      failover = {
        sessionId: matchedSession.sessionId,
        fromProfile: profile.name,
        toProfile: action.profile,
      };
    }
  }

  return { code, failover };
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
  let currentArgs = args;
  let attempts = 0;
  for (;;) {
    const { code, failover } = await runCodexOnce(realCodex, currentArgs);
    if (!failover) return code;
    attempts += 1;
    if (attempts > 10) {
      console.error("[cdxx] Stopping after 10 quota failover attempts.");
      return code;
    }
    currentArgs = ["resume", failover.sessionId];
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
