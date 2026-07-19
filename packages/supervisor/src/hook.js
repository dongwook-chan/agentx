import { supervisorRequest } from "./client.js";

export async function registerCodexHook(input, env = process.env) {
  const launcherId = env.CDXX_LAUNCHER_ID;
  if (!launcherId) return { ok: true, registered: false };
  return await supervisorRequest({
    command: "hook",
    launcherId,
    event: input.hook_event_name,
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
  });
}

export async function runHookStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return;
  await registerCodexHook(JSON.parse(input));
}
