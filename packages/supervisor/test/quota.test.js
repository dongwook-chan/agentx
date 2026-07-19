import test from "node:test";
import assert from "node:assert/strict";
import { detectAgyConversation, parseAgyModelLine, parseAgyQuotaLine, parseCodexQuotaLine } from "../src/quota.js";

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
  assert.equal(event.resetAt, new Date(1900000000 * 1000).toISOString());
});

test("parses agy identity, model scope and quota lines", () => {
  assert.equal(detectAgyConversation("Created conversation 00000000-0000-0000-0000-000000000001"), "00000000-0000-0000-0000-000000000001");
  assert.deepEqual(parseAgyModelLine('Propagating selected model override to backend: label="Gemini 2.5 Pro"'), { label: "Gemini 2.5 Pro", scope: "gemini-pro" });
  assert.equal(parseAgyQuotaLine("RESOURCE_EXHAUSTED: Individual quota reached").reason, "individual quota reached");
});
