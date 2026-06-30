import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexLaunchArgs } from "../src/launch_args.js";

test("buildCodexLaunchArgs injects the Codex yolo flag once", () => {
  assert.deepEqual(
    buildCodexLaunchArgs(["resume", "abc"], { settings: { yolo: true } }),
    ["--dangerously-bypass-approvals-and-sandbox", "resume", "abc"],
  );
  assert.deepEqual(
    buildCodexLaunchArgs(
      ["--dangerously-bypass-approvals-and-sandbox", "resume", "abc"],
      { settings: { yolo: true } },
    ),
    ["--dangerously-bypass-approvals-and-sandbox", "resume", "abc"],
  );
});

test("buildCodexLaunchArgs honors yolo off and rejects agy yolo flag", () => {
  assert.deepEqual(
    buildCodexLaunchArgs(["resume", "abc"], { settings: { yolo: false } }),
    ["resume", "abc"],
  );
  assert.throws(
    () => buildCodexLaunchArgs(["--dangerously-skip-permissions"], { settings: { yolo: true } }),
    /agy option/,
  );
});
