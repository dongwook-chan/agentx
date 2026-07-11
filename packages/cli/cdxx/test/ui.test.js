import test from "node:test";
import assert from "node:assert/strict";
import { printProfiles } from "../src/ui.js";

test("printProfiles shows reset time for available quota windows", () => {
  const originalLog = console.log;
  let output = "";
  console.log = (value) => {
    output += `${value}\n`;
  };
  try {
    printProfiles({
      activeProfile: "ready",
      profiles: [
        {
          name: "ready",
          email: "ready@example.com",
          quotaStatus: "available",
          quotaScopes: {
            "5h": {
              status: "available",
              resetAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
              remainingPercent: 42,
            },
          },
        },
      ],
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(output, /ready@example\.com/);
  assert.match(output, /│ \* │ 1 │ ready │ ready@example\.com │ ready@example\.com │ ready\s+│ 2h\s+│/);
});
