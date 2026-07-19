import { QuotaScope } from "./quota.js";

export interface SessionRecord {
  id: string;
  launcherId?: string;
  pid: number;
  childPid?: number;
  cwd: string;
  args: string[];
  conversationId?: string;
  socketPath: string;
  logPath: string;
  paused: boolean;
  restartable: boolean;
  startedAt: string;
  currentModelLabel?: string;
  currentQuotaScope?: QuotaScope;
}

export function detectConversation(content: string): string | undefined {
  const patterns = [
    /Created conversation ([0-9a-f-]{36})/gi,
    /GetConversationDetail: found conversation ([0-9a-f-]{36})/gi,
    /Conversation using ID: ([0-9a-f-]{36})/gi,
  ];
  let latest: string | undefined;
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) latest = match[1];
  }
  return latest;
}
