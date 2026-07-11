import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createQuotaSummaryFromStatus,
  parseQuotaTriggerLine,
  quotaScopesFromSummary,
  scanCodexQuota,
  scanCodexSessions,
} from "../src/quota.js";
import { QuotaTail } from "../src/quota_tail.js";
import { parseCodexStatusOutput } from "../src/status_probe.js";
import { clearExpiredQuota } from "../src/config.js";

function tokenCount(timestamp, primary, secondary, resetsAt) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 1 },
      },
      rate_limits: {
        primary: { used_percent: primary, window_minutes: 300, resets_at: resetsAt },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: resetsAt },
        credits: { has_credits: false, balance: "0" },
        plan_type: "plus",
        rate_limit_reached_type: null,
      },
    },
  });
}

function premiumCreditsDepleted(timestamp) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: "premium",
        limit_name: null,
        primary: null,
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: "0" },
        individual_limit: null,
        plan_type: null,
        rate_limit_reached_type: null,
      },
    },
  });
}

test("scanCodexSessions separates current status from historical exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-quota-"));
  try {
    const sessions = join(root, "sessions", "2026", "06", "28");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout.jsonl"),
      [
        tokenCount("2026-06-28T00:00:00.000Z", 100, 40, 1780000000),
        tokenCount("2026-06-28T01:00:00.000Z", 45, 39, 1890000000),
        "",
      ].join("\n"),
    );

    const summary = await scanCodexSessions({ sessionsDir: join(root, "sessions") });

    assert.equal(summary.tokenCountRecords, 2);
    assert.equal(summary.maxPrimary, 100);
    assert.equal(summary.current.primary, 45);
    assert.equal(summary.historicalExhausted, true);
    assert.equal(summary.exhaustedEvents, 1);
    assert.equal(summary.exhausted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanCodexSessions marks current future reset exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-quota-"));
  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    await writeFile(
      join(sessions, "rollout.jsonl"),
      `${tokenCount("2026-06-28T02:00:00.000Z", 100, 20, futureReset)}\n`,
    );

    const summary = await scanCodexSessions({ sessionsDir: sessions });

    assert.equal(summary.exhausted, true);
    assert.equal(summary.reason, "primary rate limit reached");
    assert.ok(summary.resetAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanCodexSessions treats depleted premium credits as exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-quota-"));
  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout.jsonl"),
      `${premiumCreditsDepleted("2026-07-04T10:26:18.536Z")}\n`,
    );

    const summary = await scanCodexSessions({ sessionsDir: sessions });

    assert.equal(summary.tokenCountRecords, 1);
    assert.equal(summary.exhausted, true);
    assert.equal(summary.reason, "credits exhausted");
    assert.deepEqual(summary.lastCredits, { has_credits: false, unlimited: false, balance: "0" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseCodexStatusOutput extracts account and remaining limits", () => {
  const status = parseCodexStatusOutput(`
Account: user@example.com (Plus)
Session: 019f50a5-cc11-78e3-8681-e8be2cadc5f5
5h limit: [######--------------] 29% left (resets 15:29)
Weekly limit: [############--------] 62% left
(resets 09:13 on 7 Jul)
`, Date.parse("2026-07-03T12:00:00.000Z"));

  assert.equal(status.account, "user@example.com");
  assert.equal(status.planType, "plus");
  assert.equal(status.sessionId, "019f50a5-cc11-78e3-8681-e8be2cadc5f5");
  assert.equal(status.limits.primary.remainingPercent, 29);
  assert.equal(status.limits.primary.usedPercent, 71);
  assert.equal(status.limits.secondary.remainingPercent, 62);
  assert.equal(status.limits.secondary.usedPercent, 38);
  assert.ok(status.limits.primary.resetAt);
  assert.ok(status.limits.secondary.resetAt);
});

test("parseCodexStatusOutput extracts free monthly limit", () => {
  const status = parseCodexStatusOutput(`
Account:              dongwook.chan@gmail.com (Free)
Collaboration mode:   Default
Session:              019f50a5-cc11-78e3-8681-e8be2cadc5f5

Monthly limit:        [###-----------------] 15% left (resets 09:52 on 10 Aug)
`, Date.parse("2026-07-11T09:52:00.000Z"));

  assert.equal(status.account, "dongwook.chan@gmail.com");
  assert.equal(status.planType, "free");
  assert.equal(status.sessionId, "019f50a5-cc11-78e3-8681-e8be2cadc5f5");
  assert.equal(status.limits.monthly.remainingPercent, 15);
  assert.equal(status.limits.monthly.usedPercent, 85);
  assert.ok(status.limits.monthly.resetAt);
});

test("scanCodexQuota prefers status probe over jsonl fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-quota-"));
  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    await writeFile(
      join(sessions, "rollout.jsonl"),
      `${tokenCount("2026-06-28T02:00:00.000Z", 100, 20, futureReset)}\n`,
    );

    const summary = await scanCodexQuota({
      sessionsDir: sessions,
      nowMs: Date.parse("2026-07-03T12:00:00.000Z"),
      status: {
        account: "user@example.com",
        planType: "plus",
        limits: {
          primary: { remainingPercent: 40, usedPercent: 60 },
          secondary: { remainingPercent: 70, usedPercent: 30 },
        },
      },
    });

    assert.equal(summary.source, "status");
    assert.equal(summary.exhausted, false);
    assert.equal(summary.current.primary, 60);
    assert.equal(summary.statusRemaining.primary, 40);
    assert.equal(summary.scannedFiles, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createQuotaSummaryFromStatus marks zero remaining as exhausted", () => {
  const summary = createQuotaSummaryFromStatus({
    account: "user@example.com",
    planType: "plus",
    limits: {
      primary: { remainingPercent: 0, usedPercent: 100, resetAt: "2026-07-03T15:29:00.000Z" },
      secondary: { remainingPercent: 62, usedPercent: 38 },
    },
  }, Date.parse("2026-07-03T12:00:00.000Z"));

  assert.equal(summary.source, "status");
  assert.equal(summary.exhausted, true);
  assert.equal(summary.reason, "primary status limit reached");
  assert.equal(summary.resetAt, "2026-07-03T15:29:00.000Z");
});

test("quotaScopesFromSummary preserves both Codex status windows", () => {
  const summary = createQuotaSummaryFromStatus({
    account: "user@example.com",
    planType: "plus",
    limits: {
      primary: {
        remainingPercent: 0,
        usedPercent: 100,
        resetAt: "2026-07-03T15:29:00.000Z",
        resetText: "15:29",
      },
      secondary: {
        remainingPercent: 62,
        usedPercent: 38,
        resetAt: "2026-07-07T09:13:00.000Z",
        resetText: "09:13 on 7 Jul",
      },
    },
  }, Date.parse("2026-07-03T12:00:00.000Z"));

  const scopes = quotaScopesFromSummary(summary);

  assert.equal(scopes["5h"].status, "exhausted");
  assert.equal(scopes["5h"].remainingPercent, 0);
  assert.equal(scopes["5h"].resetAt, "2026-07-03T15:29:00.000Z");
  assert.equal(scopes.weekly.status, "available");
  assert.equal(scopes.weekly.remainingPercent, 62);
  assert.equal(scopes.weekly.resetAt, "2026-07-07T09:13:00.000Z");
});

test("quotaScopesFromSummary preserves free monthly status window", () => {
  const summary = createQuotaSummaryFromStatus({
    account: "user@example.com",
    planType: "free",
    limits: {
      monthly: {
        remainingPercent: 15,
        usedPercent: 85,
        resetAt: "2026-08-10T09:52:00.000Z",
        resetText: "09:52 on 10 Aug",
      },
    },
  }, Date.parse("2026-07-11T09:52:00.000Z"));

  const scopes = quotaScopesFromSummary(summary);

  assert.equal(scopes.monthly.status, "available");
  assert.equal(scopes.monthly.remainingPercent, 15);
  assert.equal(scopes.monthly.usedPercent, 85);
  assert.equal(scopes.monthly.resetAt, "2026-08-10T09:52:00.000Z");
  assert.equal(scopes["5h"], undefined);
  assert.equal(scopes.weekly, undefined);
});

test("quotaScopesFromSummary records premium credit exhaustion as unknown quota", () => {
  const summary = {
    exhausted: true,
    reason: "credits exhausted",
    lastAt: "2026-07-04T10:26:18.536Z",
    current: {
      timestamp: "2026-07-04T10:26:18.536Z",
      primary: undefined,
      secondary: undefined,
    },
  };

  const scopes = quotaScopesFromSummary(summary);

  assert.equal(scopes.unknown.status, "exhausted");
  assert.equal(scopes.unknown.reason, "credits exhausted");
});

test("clearExpiredQuota clears expired scoped Codex quota", () => {
  const profile = {
    name: "user",
    quotaStatus: "exhausted",
    quotaResetAt: "2026-07-03T15:29:00.000Z",
    lastQuotaReason: "5h quota exhausted",
    quotaScopes: {
      "5h": {
        status: "exhausted",
        resetAt: "2026-07-03T15:29:00.000Z",
        reason: "5h quota exhausted",
      },
      weekly: {
        status: "available",
        resetAt: "2026-07-07T09:13:00.000Z",
      },
    },
  };

  clearExpiredQuota(profile, new Date("2026-07-03T15:30:00.000Z"));

  assert.equal(profile.quotaStatus, "available");
  assert.equal(profile.quotaScopes["5h"].status, "available");
  assert.equal(profile.quotaScopes["5h"].resetAt, undefined);
  assert.equal(profile.quotaScopes["5h"].resetText, undefined);
  assert.equal(profile.quotaScopes["5h"].usedPercent, undefined);
  assert.equal(profile.quotaScopes["5h"].remainingPercent, undefined);
  assert.equal(profile.quotaScopes.weekly.status, "available");
});

test("clearExpiredQuota removes inconsistent available zero-remaining scoped quota", () => {
  const profile = {
    name: "user",
    quotaStatus: "available",
    quotaScopes: {
      "5h": {
        status: "available",
        usedPercent: 100,
        remainingPercent: 0,
        resetText: "15:29",
      },
      weekly: {
        status: "available",
        usedPercent: 43,
        remainingPercent: 57,
      },
    },
  };

  clearExpiredQuota(profile, new Date("2026-07-04T00:00:00.000Z"));

  assert.equal(profile.quotaScopes["5h"].usedPercent, undefined);
  assert.equal(profile.quotaScopes["5h"].remainingPercent, undefined);
  assert.equal(profile.quotaScopes["5h"].resetText, undefined);
  assert.equal(profile.quotaScopes.weekly.remainingPercent, 57);
});

test("clearExpiredQuota recomputes aggregate status from active scoped quota", () => {
  const profile = {
    name: "user",
    quotaStatus: "available",
    quotaScopes: {
      "5h": {
        status: "exhausted",
        resetAt: "2026-07-03T15:29:00.000Z",
        reason: "5h quota exhausted",
      },
      weekly: { status: "available" },
    },
  };

  clearExpiredQuota(profile, new Date("2026-07-03T15:00:00.000Z"));

  assert.equal(profile.quotaStatus, "exhausted");
  assert.equal(profile.quotaResetAt, "2026-07-03T15:29:00.000Z");
  assert.equal(profile.lastQuotaReason, "5h quota exhausted");
});

test("parseQuotaTriggerLine treats usage-limit messages as status refresh triggers", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-03T14:52:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      content: [{
        type: "output_text",
        text: "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:29 PM.",
      }],
    },
  });

  const trigger = parseQuotaTriggerLine(line);

  assert.equal(trigger.type, "usage_limit_message");
  assert.equal(trigger.reason, "usage limit reached");
});

test("QuotaTail reads only appended quota records after offset", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-tail-"));
  try {
    const file = join(root, "rollout.jsonl");
    const existing = `${tokenCount("2026-06-28T02:00:00.000Z", 20, 10, 1890000000)}\n`;
    await writeFile(file, existing);
    const tail = new QuotaTail(file, { offset: Buffer.byteLength(existing) });

    assert.equal(await tail.readAdded(), undefined);

    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    await appendFile(file, `${tokenCount("2026-06-28T02:01:00.000Z", 100, 15, futureReset)}\n`);
    const summary = await tail.readAdded();

    assert.equal(summary.tokenCountRecords, 1);
    assert.equal(summary.current.primary, 100);
    assert.equal(summary.exhausted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QuotaTail returns usage-limit trigger even without token_count", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-tail-"));
  try {
    const file = join(root, "rollout.jsonl");
    await writeFile(file, "");
    const tail = new QuotaTail(file);

    await appendFile(file, `${JSON.stringify({
      timestamp: "2026-07-03T14:52:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        content: [{
          type: "output_text",
          text: "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:29 PM.",
        }],
      },
    })}\n`);

    const summary = await tail.readAdded();

    assert.equal(summary.tokenCountRecords, 0);
    assert.equal(summary.quotaTrigger.type, "usage_limit_message");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
