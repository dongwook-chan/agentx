import test from "node:test";
import assert from "node:assert/strict";
import { detectAgyConversation, parseAgyModelLine, parseAgyQuotaLine, parseCodexProtocolMessage, parseCodexQuotaLine } from "../src/quota.js";

test("parses Codex quota token_count events", () => {
  const event = parseCodexQuotaLine(JSON.stringify({
    timestamp: "2026-07-19T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 100, resets_at: 1900000000 },
        secondary: { used_percent: 20 },
        rate_limit_reached_type: null,
      },
    },
  }));
  assert.equal(event.primary, 100);
  assert.equal(event.primaryWindowMinutes, undefined);
  assert.equal(event.resetAt, new Date(1900000000 * 1000).toISOString());
});

test("preserves quota window durations for downstream scope normalization", () => {
  const event = parseCodexQuotaLine(JSON.stringify({
    timestamp: "2026-08-25T00:33:38.307Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 100, window_minutes: 10080, resets_at: 1788152944 },
        secondary: null,
        rate_limit_reached_type: null,
      },
    },
  }));
  assert.equal(event.primaryWindowMinutes, 10080);
  assert.equal(event.secondaryWindowMinutes, undefined);
});

test("does not treat absent purchased credits as exhausted included usage", () => {
  const event = parseCodexQuotaLine(JSON.stringify({
    timestamp: "2026-08-04T07:18:49.875Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 43, window_minutes: 10080 },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: "0" },
        rate_limit_reached_type: null,
      },
    },
  }));
  assert.equal(event, undefined);
});

test("does not treat a premium record with zero purchased credits as quota exhaustion", () => {
  const event = parseCodexQuotaLine(JSON.stringify({
    timestamp: "2026-08-28T13:44:46.500Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "premium",
        primary: null,
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: "0" },
        rate_limit_reached_type: null,
      },
    },
  }));
  assert.equal(event, undefined);
});

test("parses Codex usage_limit_exceeded task completion events", () => {
  const event = parseCodexQuotaLine(JSON.stringify({
    timestamp: "2026-08-04T07:27:30.211Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      error: {
        message: "You've hit your usage limit or try again at Aug 8th, 2026 8:16 AM.",
        codex_error_info: "usage_limit_exceeded",
      },
    },
  }));
  assert.equal(event.reachedType, "usage_limit_exceeded");
  assert.equal(event.reason, "usage limit reached");
  assert.equal(event.resetAt, "2026-08-08T08:16:00.000Z");
});

test("parses Codex app-server rate limit notifications", () => {
  const event = parseCodexProtocolMessage({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, resetsAt: 1900000000 },
        secondary: null,
        rateLimitReachedType: null,
      },
    },
  });
  assert.equal(event.primary, 100);
  assert.equal(event.resetAt, new Date(1900000000 * 1000).toISOString());
});

test("parses Codex app-server usage-limit failures", () => {
  const event = parseCodexProtocolMessage({
    method: "turn/completed",
    params: {
      turn: {
        status: "failed",
        error: {
          message: "You've hit your usage limit.",
          codexErrorInfo: "UsageLimitExceeded",
        },
      },
    },
  });
  assert.equal(event.reachedType, "usage_limit_exceeded");
});

test("parses agy identity, model scope and quota lines", () => {
  assert.equal(detectAgyConversation("Created conversation 00000000-0000-0000-0000-000000000001"), "00000000-0000-0000-0000-000000000001");
  assert.deepEqual(parseAgyModelLine('Propagating selected model override to backend: label="Gemini 2.5 Pro"'), { label: "Gemini 2.5 Pro", scope: "gemini-pro" });
  assert.equal(parseAgyQuotaLine("RESOURCE_EXHAUSTED: Individual quota reached").reason, "individual quota reached");
});
