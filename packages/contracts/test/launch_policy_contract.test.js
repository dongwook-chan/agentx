import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLaunchPolicy,
  decideUseProfile,
} from "@dong-/agentx-core";

const products = [
  {
    productName: "agy",
    yoloFlag: "--dangerously-skip-permissions",
    foreignYoloFlags: ["--dangerously-bypass-approvals-and-sandbox"],
    foreignFlagLabel: "Codex",
  },
  {
    productName: "Codex",
    yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
    foreignYoloFlags: ["--dangerously-skip-permissions"],
    foreignFlagLabel: "agy",
  },
];

for (const product of products) {
  test(`${product.productName} launch policy follows the shared yolo contract`, () => {
    assert.deepEqual(
      applyLaunchPolicy(["resume", "abc"], { ...product, yoloEnabled: true }),
      [product.yoloFlag, "resume", "abc"],
    );

    assert.deepEqual(
      applyLaunchPolicy([product.yoloFlag, "resume", "abc"], { ...product, yoloEnabled: true }),
      [product.yoloFlag, "resume", "abc"],
    );

    assert.deepEqual(
      applyLaunchPolicy(["resume", "abc"], { ...product, yoloEnabled: false }),
      ["resume", "abc"],
    );

    assert.throws(
      () => applyLaunchPolicy([product.foreignYoloFlags[0]], { ...product, yoloEnabled: true }),
      new RegExp(product.foreignFlagLabel),
    );
  });
}

test("shared use contract exits instead of opening a picker when only active is present", () => {
  assert.deepEqual(decideUseProfile([
    { name: "dtjp_86", active: true, selectable: true },
  ]), {
    type: "none",
    reason: "active_only",
    message: "'dtjp_86' is already active.",
  });
});

test("shared use contract opens selection only for non-active selectable candidates", () => {
  assert.deepEqual(decideUseProfile([]), {
    type: "empty",
    message: "No saved profiles.",
  });

  assert.equal(decideUseProfile([
    { name: "active", active: true, selectable: true },
    { name: "other", selectable: true },
  ]).type, "select");
});
