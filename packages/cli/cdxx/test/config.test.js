import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveAutoSwitchMode,
  profileNameFromIdentity,
  uniqueProfileName,
} from "../src/config.js";

test("Codex autoswitch mode normalizes legacy boolean settings", () => {
  assert.equal(effectiveAutoSwitchMode({ settings: { autoswitch: true } }), "scope-first");
  assert.equal(effectiveAutoSwitchMode({ settings: { autoswitch: false } }), "off");
  assert.equal(
    effectiveAutoSwitchMode({ settings: { autoswitch: false, autoSwitchMode: "scope-first" } }),
    "scope-first",
  );
});

test("profileNameFromIdentity derives safe profile names", () => {
  assert.equal(profileNameFromIdentity("Dong.Work+test@example.com"), "dong.work-test");
  assert.equal(profileNameFromIdentity("___Account!!!"), "account");
});

test("uniqueProfileName avoids existing profile names", () => {
  assert.equal(
    uniqueProfileName("dong", {
      profiles: [
        { name: "dong" },
        { name: "dong-2" },
      ],
    }),
    "dong-3",
  );
});
