import { fileURLToPath } from "node:url";
import { runLauncher } from "@dong-/agentx-supervisor";
import { findRealCodex, isInteractiveCodex } from "./processes.js";
import { buildCodexLaunchArgsFromState } from "./launch_args.js";
import { loadState } from "./config.js";
import { codexHooksInstalled } from "./install.js";
import { createCodexRemoteTransport, probeCodexRemoteSupport, withCodexRemote } from "./remote.js";
export { pickNextProfile } from "./selection.js";

async function runUnmanagedCodex(executable, args, reason) {
  process.stderr.write(`[cdxx] Agentx Codex integration is unavailable: ${reason}\n`);
  process.stderr.write("[cdxx] Running the regular Codex CLI without session supervision or automatic profile failover.\n");
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}

async function resolveInteractiveIntegration(realCodex) {
  const override = process.env.CDXX_INTEGRATION_MODE;
  if (override === "hooks") return { mode: "hooks" };
  if (override === "disabled") return { mode: "disabled", reason: "Disabled by CDXX_INTEGRATION_MODE." };
  const state = await loadState();
  const configured = state.codexIntegration;
  const capability = await probeCodexRemoteSupport(realCodex);
  if (override === "remote" && !capability.supported) {
    return { mode: "disabled", reason: capability.reason };
  }
  if (override === "remote") return { mode: "remote" };
  if (capability.supported && configured?.mode !== "hooks") return { mode: "remote" };
  if (await codexHooksInstalled()) return { mode: "hooks" };
  return {
    mode: "disabled",
    reason: capability.reason ?? configured?.reason ?? "No supported session identity transport is configured. Run 'cdxx install' to configure one.",
  };
}

export async function runCodexSession(args) {
  const policyCommand = fileURLToPath(new URL("./cli.js", import.meta.url));
  const realCodex = await findRealCodex();
  const interactive = isInteractiveCodex(args);
  const integration = interactive
    ? await resolveInteractiveIntegration(realCodex)
    : { mode: "none" };
  if (integration.mode === "disabled") {
    return await runUnmanagedCodex(realCodex, args, integration.reason);
  }
  if (!interactive) {
    return await runLauncher({
      product: "cdxx",
      executable: realCodex,
      args,
      policyCommand,
      restartable: false,
      buildArgs: async () => await buildCodexLaunchArgsFromState(args),
    });
  }
  return await runLauncher({
    product: "cdxx",
    executable: realCodex,
    args,
    policyCommand,
    identityMode: integration.mode,
    createTransport: integration.mode === "remote"
      ? async ({ launcherId, cwd, request, profileName }) => await createCodexRemoteTransport({
        executable: realCodex,
        launcherId,
        cwd,
        request,
        profileName,
      })
      : undefined,
    buildArgs: async ({ record, transport }) => {
      const launchArgs = await buildCodexLaunchArgsFromState(
        (record.codexThreadId ?? record.codexSessionId)
          ? ["resume", record.codexThreadId ?? record.codexSessionId]
          : args,
      );
      return integration.mode === "remote"
        ? withCodexRemote(launchArgs, transport?.remoteUrl)
        : launchArgs;
    },
  });
}
