import { strict as assert } from "node:assert";
import test from "node:test";
import { BitburnerRemoteApi } from "../dist/bitburner.js";

test("JSON-RPC response handling", async (t) => {
  await t.test("matching success response resolves pending call", async () => {
    const { api, connection } = createApi();
    const pending = api.getFile("foo.js", "home");
    const request = JSON.parse(connection.sent[0]);

    connection.emitMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: "ok"
    }));

    await assert.doesNotReject(pending);
    assert.equal(await pending, "ok");
  });

  await t.test("error response rejects pending call", async () => {
    const { api, connection } = createApi();
    const pending = api.getFile("foo.js", "home");
    const request = JSON.parse(connection.sent[0]);

    connection.emitMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: 1, message: "boom" }
    }));

    await assert.rejects(pending, /boom/);
  });

  await t.test("malformed JSON does not crash", async () => {
    const { api, connection } = createApi();
    const pending = api.getFile("foo.js", "home");
    const request = JSON.parse(connection.sent[0]);

    connection.emitMessage("not json");
    connection.emitMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: "ok"
    }));

    await assert.doesNotReject(pending);
  });

  await t.test("malformed response shape does not resolve or reject unrelated pending call", async () => {
    const { api, connection } = createApi();
    const pending = api.getFile("foo.js", "home");
    const request = JSON.parse(connection.sent[0]);

    connection.emitMessage(JSON.stringify({ jsonrpc: "2.0", result: "missing id" }));
    connection.emitMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: "ok"
    }));

    await assert.doesNotReject(pending);
  });

  await t.test("unknown id ignored", async () => {
    const { api, connection } = createApi();
    const pending = api.getFile("foo.js", "home");
    const request = JSON.parse(connection.sent[0]);

    connection.emitMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id + 100,
      result: "wrong"
    }));
    connection.emitMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: "ok"
    }));

    await assert.doesNotReject(pending);
  });

  await t.test("string error uses string text", async () => {
    const { api, connection } = createApi();
    const pending = api.getFile("foo.js", "home");
    const request = JSON.parse(connection.sent[0]);

    connection.emitMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: "bad request"
    }));

    await assert.rejects(pending, /bad request/);
  });
});

function createApi() {
  const connection = new FakeConnection();
  const api = new BitburnerRemoteApi(connection);
  return { api, connection };
}

class FakeConnection {
  sent = [];
  messageHandlers = [];
  closeHandlers = [];

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  onClose(handler) {
    this.closeHandlers.push(handler);
  }

  sendText(text) {
    this.sent.push(text);
  }

  emitMessage(text) {
    for (const handler of this.messageHandlers) {
      handler(text);
    }
  }

  emitClose() {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}
