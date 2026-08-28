import test from "node:test";
import assert from "node:assert/strict";

import { shouldHandleResumeSignal } from "../src/launcher.js";

test("launcher accepts resume signals only for one paused transition", () => {
  assert.equal(shouldHandleResumeSignal(true, false), true);
  assert.equal(shouldHandleResumeSignal(true, true), false);
  assert.equal(shouldHandleResumeSignal(false, false), false);
  assert.equal(shouldHandleResumeSignal(false, true), false);
});
