import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { WebSocketConnection, WebSocketServer } from "../dist/ws-server.js";

test("WebSocket handshake validation", async (t) => {
  const server = await startServer();

  await t.test("valid handshake succeeds", async () => {
    const key = randomBytes(16).toString("base64");
    const response = await handshake(server.port, {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key
    });

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/m);
    assert.ok(response.includes(`Sec-WebSocket-Accept: ${accept}`));
  });

  await t.test("missing key rejected", async () => {
    const response = await handshake(server.port, {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13"
    });

    assert.equal(response, "");
  });

  await t.test("invalid key rejected", async () => {
    const response = await handshake(server.port, {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "not-base64"
    });

    assert.equal(response, "");
  });

  await t.test("wrong version rejected", async () => {
    const response = await handshake(server.port, {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "12",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64")
    });

    assert.equal(response, "");
  });

  await t.test("missing upgrade rejected", async () => {
    const response = await handshake(server.port, {
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64")
    });

    assert.equal(response, "");
  });

  await t.test("invalid upgrade rejected", async () => {
    const response = await handshake(server.port, {
      Upgrade: "h2c",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64")
    });

    assert.equal(response, "");
  });

  await t.test("missing connection rejected", async () => {
    const response = await handshake(server.port, {
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64")
    });

    assert.equal(response, "");
  });

  await t.test("invalid connection rejected", async () => {
    const response = await handshake(server.port, {
      Upgrade: "websocket",
      Connection: "keep-alive",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64")
    });

    assert.equal(response, "");
  });

  server.server.closeAllConnections?.();
  server.server.close();
});

test("WebSocket frame parsing", async (t) => {
  await t.test("unmasked client frame rejected", () => {
    const { connection, socket } = createConnection();
    const closed = watchClose(connection);
    socket.feed(makeClientFrame({ opcode: 0x1, payload: Buffer.from("hi"), masked: false }));

    assert.equal(socket.destroyed, true);
    assert.equal(closed(), true);
  });

  await t.test("non-zero RSV bit rejected", () => {
    const { connection, socket } = createConnection();
    const closed = watchClose(connection);
    socket.feed(makeClientFrame({ opcode: 0x1, payload: Buffer.from("hi"), rsv1: true }));

    assert.equal(socket.destroyed, true);
    assert.equal(closed(), true);
  });

  await t.test("invalid UTF-8 text frame rejected", () => {
    const { connection, socket } = createConnection();
    const closed = watchClose(connection);
    socket.feed(makeClientFrame({ opcode: 0x1, payload: Buffer.from([0xc3, 0x28]) }));

    assert.equal(socket.destroyed, true);
    assert.equal(closed(), true);
  });

  await t.test("fragmented text message succeeds", () => {
    const { connection, socket, messages } = createConnection();
    socket.feed(makeClientFrame({ opcode: 0x1, payload: Buffer.from("hel"), fin: false }));
    socket.feed(makeClientFrame({ opcode: 0x0, payload: Buffer.from("lo") }));

    assert.deepEqual(messages, ["hello"]);
    assert.equal(socket.destroyed, false);
  });

  await t.test("ping during fragmented message gets pong and final text still succeeds", () => {
    const { connection, socket, messages } = createConnection();
    socket.feed(makeClientFrame({ opcode: 0x1, payload: Buffer.from("hel"), fin: false }));
    socket.feed(makeClientFrame({ opcode: 0x9, payload: Buffer.from("pong?") }));
    socket.feed(makeClientFrame({ opcode: 0x0, payload: Buffer.from("lo") }));

    assert.deepEqual(messages, ["hello"]);
    assert.equal(socket.writes.length >= 1, true);
    const pong = decodeServerFrame(socket.writes[0]);
    assert.equal(pong.opcode, 0xA);
    assert.equal(pong.payload.toString("utf8"), "pong?");
  });

  await t.test("oversized frame is rejected", () => {
    const { connection, socket } = createConnection();
    const closed = watchClose(connection);
    socket.feed(makeOversizedFrame());

    assert.equal(socket.destroyed, true);
    assert.equal(closed(), true);
  });
});

async function startServer() {
  const server = new WebSocketServer(0, "127.0.0.1");
  await server.listen();
  server.server.unref?.();

  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }

  return { server, port: address.port };
}

async function handshake(port, headers) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const chunks = [];
  const closePromise = once(socket, "close");

  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(socket, "connect");
  socket.write(buildRequest(headers));

  const event = await Promise.race([
    once(socket, "data").then(() => "data"),
    once(socket, "close").then(() => "close"),
    delay(200).then(() => "timeout")
  ]);

  const response = Buffer.concat(chunks).toString("utf8");
  socket.destroy();
  await Promise.race([closePromise, delay(100)]);

  assert.notEqual(event, "timeout");
  return response;
}

function buildRequest(headers) {
  const lines = ["GET / HTTP/1.1", "Host: 127.0.0.1"];

  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }

  return `${lines.join("\r\n")}\r\n\r\n`;
}

function createConnection() {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket);
  const messages = [];

  connection.onMessage((message) => messages.push(message));

  return { connection, socket, messages };
}

function watchClose(connection) {
  let closed = false;
  connection.onClose(() => {
    closed = true;
  });
  return () => closed;
}

function makeClientFrame(options) {
  const {
    fin = true,
    opcode,
    payload,
    masked = true,
    rsv1 = false,
    rsv2 = false,
    rsv3 = false
  } = options;

  const data = payload ?? Buffer.alloc(0);
  const header = [];
  const firstByte =
    (fin ? 0x80 : 0) |
    (rsv1 ? 0x40 : 0) |
    (rsv2 ? 0x20 : 0) |
    (rsv3 ? 0x10 : 0) |
    opcode;
  header.push(firstByte);

  const mask = Buffer.from([1, 2, 3, 4]);
  const length = data.length;

  if (length < 126) {
    header.push((masked ? 0x80 : 0) | length);
  } else if (length <= 0xffff) {
    header.push((masked ? 0x80 : 0) | 126);
    const ext = Buffer.alloc(2);
    ext.writeUInt16BE(length, 0);
    return masked
      ? Buffer.concat([Buffer.from(header), ext, mask, maskPayload(data, mask)])
      : Buffer.concat([Buffer.from(header), ext, data]);
  } else {
    header.push((masked ? 0x80 : 0) | 127);
    const ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(length), 0);
    return masked
      ? Buffer.concat([Buffer.from(header), ext, mask, maskPayload(data, mask)])
      : Buffer.concat([Buffer.from(header), ext, data]);
  }

  return masked
    ? Buffer.concat([Buffer.from(header), mask, maskPayload(data, mask)])
    : Buffer.concat([Buffer.from(header), data]);
}

function makeOversizedFrame() {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0xff;
  header.writeBigUInt64BE(BigInt(16 * 1024 * 1024 + 1), 2);
  return header;
}

function decodeServerFrame(buffer) {
  const first = buffer[0];
  const second = buffer[1];
  let offset = 2;
  let length = second & 0x7f;

  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    const bigLength = buffer.readBigUInt64BE(offset);
    length = Number(bigLength);
    offset += 8;
  }

  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    payload: buffer.subarray(offset, offset + length)
  };
}

function maskPayload(payload, mask) {
  const masked = Buffer.alloc(payload.length);

  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }

  return masked;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSocket {
  destroyed = false;
  ended = false;
  writes = [];
  handlers = new Map();

  on(event, handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  write(chunk) {
    this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }

  end() {
    this.ended = true;
    this.emit("close");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }

  feed(chunk) {
    this.emit("data", chunk);
  }

  emit(event, value) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(value);
    }
  }
}
