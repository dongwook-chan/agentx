import test from "node:test";
import assert from "node:assert/strict";
import { shellInit } from "../src/install.js";

test("shell integration routes codex through the dispatcher", () => {
  assert.match(shellInit(), /command cdxx dispatch -- "\$@"/);
});
