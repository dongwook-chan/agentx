import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import { createJsonRpcUnixProxy } from "../src/json_rpc_proxy.js";

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

test("Unix WebSocket proxy forwards JSON-RPC and exposes messages to an observer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentx-json-rpc-proxy-"));
  const backendPath = join(root, "backend.sock");
  const proxyPath = join(root, "proxy.sock");
  const backendServer = createServer();
  const backendWebSockets = new WebSocketServer({ noServer: true });
  const observed = [];
  backendServer.on("upgrade", (request, socket, head) => {
    backendWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
      backendWebSockets.emit("connection", webSocket, request);
    });
  });
  backendWebSockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      socket.send(JSON.stringify({
        id: request.id,
        result: { thread: { id: "thread-1", sessionId: "session-1" } },
      }));
    });
  });
  await listen(backendServer, backendPath);
  const proxy = await createJsonRpcUnixProxy({
    socketPath: proxyPath,
    backendSocketPath: backendPath,
    onMessage: ({ direction, data }) => observed.push({ direction, message: JSON.parse(data.toString()) }),
  });
  const client = new WebSocket("ws://localhost/", {
    createConnection: () => connect(proxyPath),
    perMessageDeflate: false,
  });
  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const response = await new Promise((resolve, reject) => {
      client.once("message", (data) => resolve(JSON.parse(data.toString())));
      client.once("error", reject);
      client.send(JSON.stringify({ method: "thread/start", id: 7, params: {} }));
    });
    assert.equal(response.result.thread.sessionId, "session-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(observed.map((entry) => entry.direction), ["client-to-server", "server-to-client"]);
  } finally {
    client.close();
    await new Promise((resolve) => client.once("close", resolve));
    await proxy.close();
    await new Promise((resolve) => backendWebSockets.close(resolve));
    await new Promise((resolve) => backendServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
