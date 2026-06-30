import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLaunchPolicy,
  decideUseProfile,
  useProfileDisabledReason,
} from "../src/index.js";

test("applyLaunchPolicy injects yolo flag exactly once", () => {
  const args = applyLaunchPolicy(["resume", "abc"], {
    productName: "Codex",
    yoloEnabled: true,
    yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
    foreignYoloFlags: ["--dangerously-skip-permissions"],
    foreignFlagLabel: "agy",
  });

  assert.deepEqual(args, [
    "--dangerously-bypass-approvals-and-sandbox",
    "resume",
    "abc",
  ]);
  assert.deepEqual(applyLaunchPolicy(args, {
    productName: "Codex",
    yoloEnabled: true,
    yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
    foreignYoloFlags: ["--dangerously-skip-permissions"],
    foreignFlagLabel: "agy",
  }), args);
});

test("applyLaunchPolicy honors yolo off and rejects foreign yolo flags", () => {
  assert.deepEqual(applyLaunchPolicy(["resume", "abc"], {
    productName: "agy",
    yoloEnabled: false,
    yoloFlag: "--dangerously-skip-permissions",
    foreignYoloFlags: ["--dangerously-bypass-approvals-and-sandbox"],
    foreignFlagLabel: "Codex",
  }), ["resume", "abc"]);

  assert.throws(
    () => applyLaunchPolicy(["--dangerously-bypass-approvals-and-sandbox"], {
      productName: "agy",
      yoloEnabled: true,
      yoloFlag: "--dangerously-skip-permissions",
      foreignYoloFlags: ["--dangerously-bypass-approvals-and-sandbox"],
      foreignFlagLabel: "Codex",
    }),
    /Codex option/,
  );
});

test("decideUseProfile exits active-only profile sets without opening a picker", () => {
  assert.deepEqual(decideUseProfile([]), {
    type: "empty",
    message: "No saved profiles.",
  });

  assert.deepEqual(decideUseProfile([
    { name: "dtjp_86", active: true, selectable: true },
  ]), {
    type: "none",
    reason: "active_only",
    message: "'dtjp_86' is already active.",
  });

  assert.equal(useProfileDisabledReason({
    name: "dtjp_86",
    active: true,
    selectable: true,
  }), "already active");
});

test("decideUseProfile selects only when a non-active selectable candidate exists", () => {
  assert.deepEqual(decideUseProfile([
    { name: "a", selectable: false, disabledReason: "quota exhausted" },
  ]), {
    type: "none",
    reason: "no_selectable",
    message: "No selectable profile found.",
  });

  assert.equal(decideUseProfile([
    { name: "active", active: true, selectable: true },
    { name: "next", selectable: true },
  ]).type, "select");
});
