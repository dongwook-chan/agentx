import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const nativeSupervisorBinaryByHost = {
  "darwin:arm64": "cdxx-supervisor-darwin-arm64",
  "linux:arm64": "cdxx-supervisor-linux-arm64",
};

export function nativeSupervisorBinaryName(
  platform = process.platform,
  arch = process.arch,
) {
  return nativeSupervisorBinaryByHost[`${platform}:${arch}`];
}

export function nativeSupervisorHostStatus(
  platform = process.platform,
  arch = process.arch,
) {
  const binaryName = nativeSupervisorBinaryName(platform, arch);
  const supported = Boolean(binaryName);
  return {
    supported,
    platform,
    arch,
    expected: "darwin/arm64 or linux/arm64",
    binaryName,
    message: supported
      ? undefined
      : `cdxx native supervisor supports darwin/arm64 and linux/arm64 only; current host is ${platform}/${arch}.`,
  };
}

export function nativeSupervisorPath() {
  const binaryName = nativeSupervisorBinaryName();
  if (!binaryName) throw new Error(nativeSupervisorHostStatus().message);
  return fileURLToPath(new URL(`../bin/${binaryName}`, import.meta.url));
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runNativeSupervisor(args, realCodex) {
  const host = nativeSupervisorHostStatus();
  if (!host.supported) {
    if (process.env.CDXX_REQUIRE_NATIVE_SUPERVISOR === "1") {
      throw new Error(host.message);
    }
    return undefined;
  }

  const binary = nativeSupervisorPath();
  if (!await executable(binary)) {
    if (process.env.CDXX_REQUIRE_NATIVE_SUPERVISOR === "1") {
      throw new Error(`Native supervisor binary not found: ${binary}. Run 'npm run build:native'.`);
    }
    console.error(`cdxx: native supervisor binary not found; using Node supervisor fallback. (${binary})`);
    return undefined;
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: {
        ...process.env,
        CDXX_REAL_CODEX: realCodex,
        CDXX_CLI_PATH: fileURLToPath(new URL("./cli.js", import.meta.url)),
        CDXX_NODE_PATH: process.execPath,
      },
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
