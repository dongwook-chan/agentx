export interface JsonRpcProxyMessage {
  direction: "client-to-server" | "server-to-client";
  data: Buffer;
  isBinary: boolean;
}

export function createJsonRpcUnixProxy(options: {
  socketPath: string;
  backendSocketPath: string;
  onMessage?(message: JsonRpcProxyMessage): Promise<void> | void;
}): Promise<{ socketPath: string; close(): Promise<void> }>;
