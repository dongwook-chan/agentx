import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pickNextProfile,
} from "../src/session.js";
import {
  findMatchingSession,
  snapshotSessionFiles,
  waitForMatchingSession,
} from "../src/session_match.js";

function sessionMeta({ id, timestamp, cwd, originator = "codex-tui" }) {
  return `${JSON.stringify({
    timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(),
    type: "session_meta",
    payload: {
      session_id: id,
      id,
      timestamp,
      cwd,
      originator,
      cli_version: "0.142.3",
      source: "cli",
      thread_source: "user",
    },
  })}\n`;
}

async function writeSession(root, name, meta) {
  const dir = join(root, "2026", "06", "28");
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, meta);
  return file;
}

test("findMatchingSession selects a new matching cwd session after snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-match-"));
  try {
    await writeSession(root, "old.jsonl", sessionMeta({
      id: "00000000-0000-0000-0000-000000000001",
      timestamp: "2026-06-28T00:00:00.000Z",
      cwd: "/tmp/project",
    }));
    const before = await snapshotSessionFiles(root);
    const startMs = Date.parse("2026-06-28T01:00:00.000Z");
    await writeSession(root, "wrong-cwd.jsonl", sessionMeta({
      id: "00000000-0000-0000-0000-000000000002",
      timestamp: "2026-06-28T01:00:01.000Z",
      cwd: "/tmp/other",
    }));
    await writeSession(root, "new.jsonl", sessionMeta({
      id: "00000000-0000-0000-0000-000000000003",
      timestamp: "2026-06-28T01:00:02.000Z",
      cwd: "/tmp/project",
    }));

    const match = await findMatchingSession({
      sessionsDir: root,
      before,
      cwd: "/tmp/project",
      startMs,
    });

    assert.equal(match.sessionId, "00000000-0000-0000-0000-000000000003");
    assert.equal(match.cwd, "/tmp/project");
    assert.equal(match.previousSize, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findMatchingSession preserves previous size for modified existing session", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-match-"));
  try {
    const file = await writeSession(root, "existing.jsonl", sessionMeta({
      id: "00000000-0000-0000-0000-000000000005",
      timestamp: "2026-06-28T03:00:00.000Z",
      cwd: "/tmp/project",
    }));
    const before = await snapshotSessionFiles(root);
    const previousSize = before.get(file).size;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(file, `${sessionMeta({
      id: "00000000-0000-0000-0000-000000000005",
      timestamp: "2026-06-28T03:00:01.000Z",
      cwd: "/tmp/project",
    })}{"type":"event_msg","payload":{"type":"token_count","rate_limits":{}}}\n`);

    const match = await findMatchingSession({
      sessionsDir: root,
      before,
      cwd: "/tmp/project",
      startMs: Date.parse("2026-06-28T03:00:00.000Z"),
    });

    assert.equal(match.sessionId, "00000000-0000-0000-0000-000000000005");
    assert.equal(match.previousSize, previousSize);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waitForMatchingSession notices a session created after polling starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-match-"));
  try {
    const before = await snapshotSessionFiles(root);
    const startMs = Date.now();
    const pending = waitForMatchingSession({
      sessionsDir: root,
      before,
      cwd: "/tmp/live",
      startMs,
      timeoutMs: 3000,
      intervalMs: 50,
    });
    setTimeout(() => {
      void writeSession(root, "live.jsonl", sessionMeta({
        id: "00000000-0000-0000-0000-000000000004",
        timestamp: new Date(startMs + 100).toISOString(),
        cwd: "/tmp/live",
      }));
    }, 100);

    const match = await pending;

    assert.equal(match.sessionId, "00000000-0000-0000-0000-000000000004");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pickNextProfile starts at first profile when active profile is missing", () => {
  const state = {
    activeProfile: undefined,
    profiles: [
      { name: "a", quotaStatus: "available" },
      { name: "b", quotaStatus: "available" },
    ],
  };

  assert.equal(pickNextProfile(state).name, "a");
});
