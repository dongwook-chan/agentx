import test from "node:test";
import assert from "node:assert/strict";
import {
  profileNameFromIdentity,
  uniqueProfileName,
} from "../src/config.js";

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
