import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  codexContinuationArgs,
  startCodexSessionContinuation,
} from "../src/session_continuation.js";

test("unmanaged Codex continuation resumes the exact session with the configured prompt", async () => {
  assert.deepEqual(codexContinuationArgs("session-a", "continue"), [
    "exec",
    "resume",
    "--all",
    "session-a",
    "continue",
  ]);

  let invocation;
  let unrefCalled = false;
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => { unrefCalled = true; };
  const resultPromise = startCodexSessionContinuation(
    { sessionId: "session-a", prompt: "continue" },
    {
      findExecutable: async () => "/path/to/codex",
      buildArgs: async (args) => ["--dangerously-bypass-approvals-and-sandbox", ...args],
      spawnProcess: (executable, args, options) => {
        invocation = { executable, args, options };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    },
  );

  assert.deepEqual(await resultPromise, { pid: 12345 });
  assert.equal(unrefCalled, true);
  assert.equal(invocation.executable, "/path/to/codex");
  assert.deepEqual(invocation.args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "exec",
    "resume",
    "--all",
    "session-a",
    "continue",
  ]);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.stdio, "ignore");
});
