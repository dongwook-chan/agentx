import test from "node:test";
import assert from "node:assert/strict";
import {
  agentCliManifests,
  applyLaunchPolicy,
  credentialLifecyclePolicy,
  decideExplicitProfileUse,
  decideLiveQuotaFailover,
  decideUseProfile,
  usageCheckPolicies,
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

test("shared use contract opens picker when any saved profile is present", () => {
  assert.equal(decideUseProfile([
    { name: "dtjp_86", active: true, selectable: true },
  ]).type, "select");
});

test("shared use contract reports empty only when no profiles are saved", () => {
  assert.deepEqual(decideUseProfile([]), {
    type: "empty",
    message: "No saved profiles.",
  });

  assert.equal(decideUseProfile([
    { name: "quota", selectable: false, disabledReason: "quota exhausted" },
  ]).type, "select");

  assert.equal(decideUseProfile([
    { name: "active", active: true, selectable: true },
    { name: "other", selectable: true },
  ]).type, "select");
});

test("CLI login semantics are recorded in the shared manifest", () => {
  assert.equal(agentCliManifests.agy.login.requiresActiveSlotClearedBeforeLogin, true);
  assert.equal(agentCliManifests.agy.login.clearsActiveCredentialAtStart, false);
  assert.equal(agentCliManifests.agy.login.isolatesLoginEnvironment, false);
  assert.equal(agentCliManifests.agy.login.mustRestorePreviousActiveOnFailure, true);

  assert.equal(agentCliManifests.codex.login.requiresActiveSlotClearedBeforeLogin, false);
  assert.equal(agentCliManifests.codex.login.clearsActiveCredentialAtStart, true);
  assert.equal(agentCliManifests.codex.login.isolatesLoginEnvironment, true);
  assert.equal(agentCliManifests.codex.login.mustRestorePreviousActiveOnFailure, true);
  assert.equal(agentCliManifests.codex.login.successRequiresCredentialValidation, true);
});

test("agyx and cdxx share one mutable credential lifecycle policy", () => {
  assert.equal(agentCliManifests.agy.credentials.lifecycle, credentialLifecyclePolicy);
  assert.equal(agentCliManifests.codex.credentials.lifecycle, credentialLifecyclePolicy);
  assert.deepEqual(
    agentCliManifests.agy.credentials.lifecycle,
    agentCliManifests.codex.credentials.lifecycle,
  );
  assert.equal(credentialLifecyclePolicy.persistActiveBeforeReplacement, true);
  assert.equal(credentialLifecyclePolicy.persistAfterRefreshCapableOperation, true);
  assert.equal(credentialLifecyclePolicy.isolatedCredentialMutationsMustMergeBack, true);
  assert.equal(credentialLifecyclePolicy.concurrentRefreshesAllowed, false);
});

test("manual use of an unavailable profile is a shared confirmation policy", () => {
  for (const product of ["agy", "codex"]) {
    assert.equal(agentCliManifests[product].id, product);
    assert.equal(decideExplicitProfileUse({
      name: `${product}-limited`,
      selectable: false,
      disabledReason: "quota exhausted",
    }).type, "confirm");
  }
});

test("all CLI manifests obey the core live-quota failover policy", () => {
  for (const manifest of Object.values(agentCliManifests)) {
    assert.equal(manifest.quotaFailover.definitiveLiveExhaustionSwitchesImmediately, true);
    assert.equal(manifest.quotaFailover.usageRefreshMayBlockFailover, false);
  }

  assert.equal(usageCheckPolicies["session-start"].foregroundAllowed, false);
  assert.equal(usageCheckPolicies["live-quota-trigger"].foregroundAllowed, false);
  assert.equal(usageCheckPolicies["background-live-quota-refresh"].foregroundAllowed, false);
  assert.deepEqual(decideLiveQuotaFailover(true), {
    switchImmediately: true,
    usageRefreshMayBlock: false,
  });

  assert.deepEqual(agentCliManifests.agy.quotaFailover.supportedAutoSwitchModes, [
    "off",
    "scope-first",
    "all-scopes",
  ]);
  assert.equal(agentCliManifests.agy.quotaFailover.defaultAutoSwitchMode, "all-scopes");
  assert.equal(agentCliManifests.agy.quotaFailover.candidateQuotaPolicy, "trigger-scope");
  assert.deepEqual(agentCliManifests.agy.quotaFailover.supportedEligibilityModes, ["allow", "block"]);
  assert.equal(agentCliManifests.agy.quotaFailover.defaultEligibilityMode, "allow");
  assert.equal(agentCliManifests.agy.quotaFailover.observesUnmanagedSessionTranscripts, false);

  assert.deepEqual(agentCliManifests.codex.quotaFailover.supportedAutoSwitchModes, [
    "off",
    "scope-first",
  ]);
  assert.equal(agentCliManifests.codex.quotaFailover.defaultAutoSwitchMode, "off");
  assert.equal(agentCliManifests.codex.quotaFailover.candidateQuotaPolicy, "any-scope");
  assert.equal(agentCliManifests.codex.quotaFailover.observesUnmanagedSessionTranscripts, true);
  assert.deepEqual(agentCliManifests.codex.quotaFailover.unmanagedTranscriptObservation, {
    changeNotifications: "hint",
    reconcileTrackedFileSizes: true,
    reconcileRecentSessionDirectories: true,
    activeFileHorizonMs: 172_800_000,
    maxReconcileDelayMs: 1_000,
    heartbeatIntervalMs: 30_000,
    recoveryDiagnoses: [
      "file_change_notification_missing",
      "new_file_notification_missing",
      "directory_watcher_missing",
      "notified_change_not_drained",
    ],
  });
  assert.equal(agentCliManifests.agy.quotaFailover.unmanagedTranscriptObservation, undefined);
  assert.match(
    agentCliManifests.codex.quotaFailover.unsupportedAutoSwitchModes["all-scopes"],
    /cumulative blockers/,
  );
  assert.deepEqual(agentCliManifests.codex.quotaFailover.supportedEligibilityModes, []);
  assert.match(agentCliManifests.codex.quotaFailover.unsupportedEligibilityReason, /no eligibility state/);
});
