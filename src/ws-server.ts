import { createServer, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { Socket } from "node:net";

type MessageHandler = (message: string) => void;
type CloseHandler = () => void;
type Frame = {
  fin: boolean;
  opcode: number;
  payload: Buffer;
};

const MAX_FRAME_PAYLOAD_LENGTH = 16 * 1024 * 1024;
const MAX_MESSAGE_PAYLOAD_LENGTH = 64 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class WebSocketConnection {
  private buffer = Buffer.alloc(0);
  private fragmentedOpcode: number | null = null;
  private fragmentedPayloads: Buffer[] = [];
  private fragmentedPayloadLength = 0;
  private isClosed = false;
  private closeNotified = false;
  private messageHandlers: MessageHandler[] = [];
  private closeHandlers: CloseHandler[] = [];

  constructor(private socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("close", () => this.notifyClose());
    socket.on("error", () => this.notifyClose());
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: CloseHandler): void {
    this.closeHandlers.push(handler);
  }

  sendText(text: string): void {
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  private sendPong(payload: Buffer): void {
    this.sendFrame(0xA, payload);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      this.socket.write(this.makeHeader(0, 0x8));
    } catch {
      this.safeDestroy();
      this.notifyClose();
      return;
    }

    this.socket.end();
  }

  private makeHeader(length: number, opcode: number): Buffer {
    if (length < 126) {
      return Buffer.from([0x80 | opcode, length]);
    }

    if (length <= 0xffff) {
      const header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
      return header;
    }

    const header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    return header;
  }

  private handleData(chunk: Buffer): void {
    if (this.isClosed) {
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);

    try {
      while (true) {
        const frame = this.readFrame();
        if (!frame) return;

        this.handleFrame(frame);
        if (this.isClosed) {
          return;
        }
      }
    } catch {
      this.failConnection();
    }
  }

  private readFrame(): Frame | null {
    if (this.buffer.length < 2) return null;

    const first = this.buffer[0];
    const second = this.buffer[1];

    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      throw new Error("Reserved WebSocket bits must be zero");
    }

    if (!isSupportedOpcode(opcode)) {
      throw new Error("Unsupported WebSocket opcode");
    }

    if (length === 126) {
      if (this.buffer.length < offset + 2) return null;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return null;
      const bigLength = this.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket frame too large");
      }
      length = Number(bigLength);
      offset += 8;
    }

    if (length > MAX_FRAME_PAYLOAD_LENGTH) {
      throw new Error("WebSocket frame too large");
    }

    if ((second & 0x80) === 0) {
      throw new Error("Client frames must be masked");
    }

    if (this.buffer.length < offset + 4) return null;
    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;

    if (isControlOpcode(opcode) && !fin) {
      throw new Error("Control frames must not be fragmented");
    }

    if (isControlOpcode(opcode) && length > 125) {
      throw new Error("Control frame payload too large");
    }

    if (this.buffer.length < offset + length) return null;

    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);

    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }

    return { fin, opcode, payload };
  }

  private handleFrame(frame: Frame): void {
    switch (frame.opcode) {
      case 0x0:
        this.handleContinuation(frame);
        return;
      case 0x1:
        this.handleTextFrame(frame);
        return;
      case 0x8:
        this.close();
        return;
      case 0x9:
        this.sendPong(frame.payload);
        return;
      case 0xA:
        return;
      default:
        throw new Error("Unsupported WebSocket opcode");
    }
  }

  private handleTextFrame(frame: Frame): void {
    if (this.fragmentedOpcode !== null) {
      throw new Error("Unexpected text frame during fragmented message");
    }

    if (frame.fin) {
      this.emitMessage(decodeUtf8(frame.payload));
      return;
    }

    this.fragmentedOpcode = frame.opcode;
    this.fragmentedPayloads = [frame.payload];
    this.fragmentedPayloadLength = frame.payload.length;
  }

  private handleContinuation(frame: Frame): void {
    if (this.fragmentedOpcode === null) {
      throw new Error("Unexpected continuation frame");
    }

    if (this.fragmentedPayloadLength + frame.payload.length > MAX_MESSAGE_PAYLOAD_LENGTH) {
      throw new Error("WebSocket message too large");
    }

    this.fragmentedPayloads.push(frame.payload);
    this.fragmentedPayloadLength += frame.payload.length;

    if (!frame.fin) {
      return;
    }

    const payload = Buffer.concat(this.fragmentedPayloads);
    const opcode = this.fragmentedOpcode;
    this.fragmentedOpcode = null;
    this.fragmentedPayloads = [];
    this.fragmentedPayloadLength = 0;

    if (opcode !== 0x1) {
      throw new Error("Unsupported fragmented message opcode");
    }

    this.emitMessage(decodeUtf8(payload));
  }

  private emitMessage(message: string): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.isClosed) {
      return;
    }

    try {
      this.socket.write(Buffer.concat([this.makeHeader(payload.length, opcode), payload]));
    } catch {
      this.failConnection();
    }
  }

  private failConnection(): void {
    if (this.isClosed) {
      return;
    }

    this.safeDestroy();
    this.notifyClose();
  }

  private safeDestroy(): void {
    try {
      this.socket.destroy();
    } catch {
      // Ignore socket teardown errors.
    }
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.isClosed = true;
    this.closeHandlers.forEach((fn) => fn());
  }
}

export class WebSocketServer {
  private server = createServer((_, res) => {
    res.destroy();
  });
  private connectionHandlers: ((connection: WebSocketConnection) => void)[] = [];
  private sockets = new Set<Socket>();

  constructor(private port: number, private host: string) {}

  onConnection(handler: (connection: WebSocketConnection) => void): void {
    this.connectionHandlers.push(handler);
  }

  listen(): Promise<void> {
    this.server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
      try {
        if (!isValidUpgradeRequest(req)) {
          safeDestroySocket(socket);
          return;
        }

        const key = req.headers["sec-websocket-key"];
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");

        socket.write([
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          ""
        ].join("\r\n"));

        const connection = new WebSocketConnection(socket);
        this.sockets.add(socket);
        connection.onClose(() => {
          this.sockets.delete(socket);
        });
        this.connectionHandlers.forEach((fn) => fn(connection));
      } catch {
        safeDestroySocket(socket);
      }
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, resolve);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const socket of this.sockets) {
        safeDestroySocket(socket);
      }

      this.server.closeIdleConnections?.();
      this.server.closeAllConnections?.();

      this.server.close((error: Error | undefined) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

function isValidUpgradeRequest(req: IncomingMessage): boolean {
  if (req.method !== "GET") {
    return false;
  }

  if (!isExactHeaderToken(req.headers.upgrade, "websocket")) {
    return false;
  }

  if (!headerHasToken(req.headers.connection, "upgrade")) {
    return false;
  }

  if (req.headers["sec-websocket-version"] !== "13") {
    return false;
  }

  return isValidWebSocketKey(req.headers["sec-websocket-key"]);
}

function headerHasToken(value: string | string[] | undefined, token: string): boolean {
  const text = normalizeHeaderValue(value);
  if (!text) {
    return false;
  }

  return text
    .split(",")
    .some((part) => part.trim().toLowerCase() === token.toLowerCase());
}

function isExactHeaderToken(value: string | string[] | undefined, token: string): boolean {
  const text = normalizeHeaderValue(value);
  return text !== null && text.toLowerCase() === token.toLowerCase();
}

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(",");
  }

  return null;
}

function isValidWebSocketKey(value: string | string[] | undefined): boolean {
  const key = normalizeHeaderValue(value);
  if (key === null) {
    return false;
  }

  const normalized = key.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    return false;
  }

  const decoded = Buffer.from(normalized, "base64");
  return decoded.length === 16 && decoded.toString("base64") === normalized;
}

function decodeUtf8(payload: Buffer): string {
  return utf8Decoder.decode(payload);
}

function isControlOpcode(opcode: number): boolean {
  return opcode >= 0x8;
}

function isSupportedOpcode(opcode: number): boolean {
  return opcode === 0x0 || opcode === 0x1 || opcode === 0x8 || opcode === 0x9 || opcode === 0xA;
}

function safeDestroySocket(socket: Socket): void {
  try {
    socket.destroy();
  } catch {
    // Ignore teardown errors.
  }
}
