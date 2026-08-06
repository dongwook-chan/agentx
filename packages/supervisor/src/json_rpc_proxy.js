import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

function closeWebSocket(socket) {
  if (!socket) return;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}

/**
 * Exposes a WebSocket endpoint on a Unix socket and forwards each connection to
 * another Unix-socket WebSocket endpoint. Product adapters can observe decoded
 * JSON-RPC messages without adding product knowledge to the shared launcher.
 */
export async function createJsonRpcUnixProxy(options) {
  const socketPath = options.socketPath;
  const backendSocketPath = options.backendSocketPath;
  const onMessage = options.onMessage ?? (() => undefined);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });

  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const connections = new Set();

  webSocketServer.on("connection", (client, request) => {
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const backend = new WebSocket("ws://localhost/", protocols, {
      createConnection: () => connect(backendSocketPath),
      perMessageDeflate: false,
    });
    const pair = { client, backend, pending: [] };
    connections.add(pair);

    const finish = () => {
      closeWebSocket(client);
      closeWebSocket(backend);
      connections.delete(pair);
    };
    client.on("message", (data, isBinary) => {
      void Promise.resolve(onMessage({ direction: "client-to-server", data, isBinary })).catch(() => undefined);
      if (backend.readyState === WebSocket.OPEN) backend.send(data, { binary: isBinary });
      else pair.pending.push({ data: Buffer.from(data), isBinary });
    });
    backend.on("open", () => {
      for (const message of pair.pending) backend.send(message.data, { binary: message.isBinary });
      pair.pending.length = 0;
    });
    backend.on("message", (data, isBinary) => {
      void Promise.resolve(onMessage({ direction: "server-to-client", data, isBinary })).catch(() => undefined);
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on("close", finish);
    backend.on("close", finish);
    client.on("error", finish);
    backend.on("error", finish);
  });

  server.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600).catch(() => undefined);

  return {
    socketPath,
    async close() {
      for (const pair of connections) {
        closeWebSocket(pair.client);
        closeWebSocket(pair.backend);
      }
      connections.clear();
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      await rm(socketPath, { force: true });
    },
  };
}
