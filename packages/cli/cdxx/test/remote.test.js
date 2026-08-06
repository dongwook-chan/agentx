import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import {
  createCodexRemoteTransport,
  probeCodexRemoteSupport,
  withCodexRemote,
} from "../src/remote.js";

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

test("remote capability probe checks the CLI option and listen-capable app-server", async () => {
  const calls = [];
  const capture = async (_executable, args) => {
    calls.push(args);
    return args[0] === "--help"
      ? { ok: true, output: "--remote <ADDR>" }
      : { ok: true, output: "--listen <URL>" };
  };
  assert.deepEqual(await probeCodexRemoteSupport("codex", { capture }), { supported: true });
  assert.deepEqual(calls, [["--help"], ["app-server", "--help"]]);
});

test("remote capability probe reports why integration is unavailable", async () => {
  const result = await probeCodexRemoteSupport("codex", {
    capture: async () => ({ ok: true, output: "Codex CLI" }),
  });
  assert.equal(result.supported, false);
  assert.match(result.reason, /--remote/);
});

test("Codex transport captures session identity from the thread response", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdxx-remote-transport-"));
  const backendPath = join(root, "backend.sock");
  const proxyPath = join(root, "proxy.sock");
  const backendServer = createServer();
  const backendWebSockets = new WebSocketServer({ noServer: true });
  const requests = [];
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
        result: { thread: { id: "thread-1", sessionId: "session-root" } },
      }));
    });
  });
  await listen(backendServer, backendPath);
  const transport = await createCodexRemoteTransport({
    executable: "unused",
    launcherId: "launch-1",
    cwd: "/tmp/project",
    request: async (payload) => {
      requests.push(payload);
      return { ok: true };
    },
    socketPath: backendPath,
    proxySocketPath: proxyPath,
    managedBackend: false,
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
    await new Promise((resolve, reject) => {
      client.once("message", resolve);
      client.once("error", reject);
      client.send(JSON.stringify({ method: "thread/start", id: 9, params: {} }));
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, [{
      command: "identity",
      launcherId: "launch-1",
      sessionId: "session-root",
      threadId: "thread-1",
      cwd: "/tmp/project",
    }]);
    assert.deepEqual(withCodexRemote(["resume", "session-root"], transport.remoteUrl), [
      "--remote",
      `unix://${proxyPath}`,
      "resume",
      "session-root",
    ]);
  } finally {
    client.close();
    await new Promise((resolve) => client.once("close", resolve));
    await transport.close();
    await new Promise((resolve) => backendWebSockets.close(resolve));
    await new Promise((resolve) => backendServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("agentx-managed sessions reject a caller-provided remote endpoint", () => {
  assert.throws(
    () => withCodexRemote(["--remote", "unix:///custom.sock"], "unix:///agentx.sock"),
    /codex --native/,
  );
});
