import test from "node:test";
import assert from "node:assert/strict";
import { applyLaunchPolicy } from "../src/index.js";

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
