import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanCodexSessions } from "../src/quota.js";
import { QuotaTail } from "../src/quota_tail.js";

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
