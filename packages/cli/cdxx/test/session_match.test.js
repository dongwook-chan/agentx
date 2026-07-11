import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pickNextProfile,
} from "../src/session.js";
import {
  findSessionIdByThreadName,
  findSessionById,
  findMatchingSession,
  isCodexSessionId,
  snapshotSessionFiles,
  waitForSessionFileChange,
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

test("findSessionById matches resumed sessions that existed before launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-match-"));
  try {
    const id = "00000000-0000-0000-0000-000000000006";
    const file = await writeSession(root, `rollout-${id}.jsonl`, sessionMeta({
      id,
      timestamp: "2026-06-28T04:00:00.000Z",
      cwd: "/tmp/original",
    }));
    const before = await snapshotSessionFiles(root);

    const match = await findSessionById(id, { sessionsDir: root, before });

    assert.equal(match.sessionId, id);
    assert.equal(match.file, file);
    assert.equal(match.previousSize, before.get(file).size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findSessionIdByThreadName resolves latest session index alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-session-index-"));
  try {
    const indexPath = join(root, "session_index.jsonl");
    await writeFile(indexPath, [
      JSON.stringify({
        id: "00000000-0000-0000-0000-000000000008",
        thread_name: "agentx",
        updated_at: "2026-07-10T00:00:00.000Z",
      }),
      JSON.stringify({
        id: "00000000-0000-0000-0000-000000000009",
        thread_name: "agentx",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
      JSON.stringify({
        id: "00000000-0000-0000-0000-000000000010",
        thread_name: "other",
        updated_at: "2026-07-12T00:00:00.000Z",
      }),
      "",
    ].join("\n"));

    const id = await findSessionIdByThreadName("agentx", { indexPath });

    assert.equal(id, "00000000-0000-0000-0000-000000000009");
    assert.equal(isCodexSessionId(id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findMatchingSession reports non-session_meta first line without scanning whole file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-match-"));
  try {
    const before = await snapshotSessionFiles(root);
    await writeSession(
      root,
      "bad.jsonl",
      `${JSON.stringify({ type: "event_msg", payload: {} })}\n${"x".repeat(128 * 1024)}`,
    );
    const errors = [];

    const match = await findMatchingSession({
      sessionsDir: root,
      before,
      cwd: "/tmp/project",
      startMs: Date.now() - 1000,
      onFormatError: (message) => errors.push(message),
    });

    assert.equal(match, undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /expected 'session_meta'/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waitForSessionFileChange waits for a real append after snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-match-"));
  try {
    const file = await writeSession(root, "pending.jsonl", "");
    const before = await snapshotSessionFiles(root);
    const pending = waitForSessionFileChange({
      sessionsDir: root,
      before,
      intervalMs: 50,
    });
    setTimeout(() => {
      void writeFile(file, sessionMeta({
        id: "00000000-0000-0000-0000-000000000007",
        timestamp: new Date().toISOString(),
        cwd: "/tmp/live",
      }));
    }, 100);

    const changed = await pending;

    assert.equal(changed.file, file);
    assert.equal(changed.previousSize, 0);
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
