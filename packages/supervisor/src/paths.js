import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function productConfigDir(product) {
  if (product === "agyx") {
    return process.env.AGYX_CONFIG_DIR ?? join(homedir(), ".config", "agyx");
  }
  const current = join(homedir(), ".config", "cdxx");
  const legacy = join(homedir(), ".config", "codexx");
  return process.env.CDXX_CONFIG_DIR
    ?? process.env.CODEXX_CONFIG_DIR
    ?? (existsSync(current) || !existsSync(legacy) ? current : legacy);
}

export function supervisorConfigDir() {
  return process.env.AGENTX_SUPERVISOR_DIR ?? join(homedir(), ".config", "agentx");
}

export function supervisorRuntimeDir() {
  return join(supervisorConfigDir(), "run");
}

export function supervisorSocketPath() {
  return process.env.AGENTX_SUPERVISOR_SOCKET ?? join(supervisorRuntimeDir(), "supervisor.sock");
}

export function supervisorStatePath() {
  if (process.env.AGENTX_SUPERVISOR_STATE) return process.env.AGENTX_SUPERVISOR_STATE;
  if (process.env.AGENTX_SUPERVISOR_SOCKET) {
    return join(dirname(process.env.AGENTX_SUPERVISOR_SOCKET), "supervisor.json");
  }
  return join(supervisorRuntimeDir(), "supervisor.json");
}
