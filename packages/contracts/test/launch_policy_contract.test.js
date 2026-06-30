import test from "node:test";
import assert from "node:assert/strict";
import { applyLaunchPolicy } from "@dong-/agentx-core";

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
