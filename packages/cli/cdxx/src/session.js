import { runNativeSupervisor } from "./native.js";
import { findRealCodex } from "./processes.js";
export { pickNextProfile } from "./selection.js";

export async function runCodexSession(args) {
  return await runNativeSupervisor(args, await findRealCodex());
}
