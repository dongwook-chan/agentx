#!/usr/bin/env node
"use strict";

const { copyFileSync, mkdirSync, chmodSync, writeFileSync, renameSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  supportedNativeSupervisors,
  hostKey,
  supportedHostText,
} = require("./native-targets.cjs");

const key = hostKey();
const binaryName = supportedNativeSupervisors[key];
if (!binaryName) {
  console.error(`Unsupported native build host: ${key}`);
  console.error(`Supported native build hosts: ${supportedHostText()}`);
  process.exit(1);
}

const crateDir = join(__dirname, "..", "native", "cdxx-supervisor");
const result = spawnSync("cargo", ["build", "--release"], {
  cwd: crateDir,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

const binDir = join(__dirname, "..", "bin");
mkdirSync(binDir, { recursive: true });
const sourceBinary = join(crateDir, "target", "release", "cdxx-supervisor");
const targetBinary = join(binDir, binaryName);
const replacedBinary = `${targetBinary}.old-${process.pid}`;
try {
  renameSync(targetBinary, replacedBinary);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  copyFileSync(sourceBinary, targetBinary);
  chmodSync(targetBinary, 0o755);
} finally {
  rmSync(replacedBinary, { force: true });
}

const launcher = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const supported = ${JSON.stringify(supportedNativeSupervisors, null, 2)};
const binary = supported[\`\${process.platform}:\${process.arch}\`];
if (!binary) {
  console.error(\`cdxx-supervisor does not support \${process.platform}/\${process.arch}\`);
  process.exit(1);
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, binary);
if (!existsSync(path)) {
  console.error(\`Missing native supervisor binary: \${path}\`);
  process.exit(1);
}
const result = spawnSync(path, process.argv.slice(2), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`;
writeFileSync(join(binDir, "cdxx-supervisor"), launcher, { mode: 0o755 });
chmodSync(join(binDir, "cdxx-supervisor"), 0o755);

if (process.platform === "darwin") {
  const codesignResult = spawnSync("codesign", ["-f", "-s", "-", join(binDir, binaryName)], {
    stdio: "inherit",
  });
  if (codesignResult.status !== 0) {
    console.warn(`Warning: codesign failed with status ${codesignResult.status}`);
  }
}

console.log(`Built bin/${binaryName}`);
