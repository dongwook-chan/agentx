#!/usr/bin/env node
"use strict";

const {
  packagedNativeSupervisors,
  hostKey,
  supportedHostText,
} = require("./native-targets.cjs");

if (packagedNativeSupervisors[hostKey()]) {
  process.exit(0);
}

console.error(
  [
    "cdxx installation aborted.",
    `Native supervisor package supports ${supportedHostText()} only.`,
    `Current host is ${process.platform}/${process.arch}.`,
  ].join("\n"),
);
process.exit(1);
