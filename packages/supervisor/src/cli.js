#!/usr/bin/env node
import { runDaemon } from "./daemon.js";
import { runHookStdin } from "./hook.js";
import { sendSupervisor } from "./client.js";

const command = process.argv[2];
if (command === "daemon") {
  await runDaemon();
} else if (command === "codex-hook") {
  await runHookStdin();
} else if (command === "sessions") {
  console.log(JSON.stringify(await sendSupervisor({ command: "sessions" }), null, 2));
} else {
  console.error("Usage: agentx-supervisor <daemon|codex-hook|sessions>");
  process.exitCode = 1;
}
