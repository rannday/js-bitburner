import { createServer } from "node:http";
import { createHash } from "node:crypto";

type MessageHandler = (message: string) => void;
type CloseHandler = () => void;

const MAX_FRAME_PAYLOAD_LENGTH = 16 * 1024 * 1024;
const MAX_MESSAGE_PAYLOAD_LENGTH = 64 * 1024 * 1024;

export class WebSocketConnection {
  private buffer = Buffer.alloc(0);
  private fragmentedOpcode: number | null = null;
  private fragmentedPayloads: any[] = [];
  private fragmentedPayloadLength = 0;
  private isClosed = false;
  private closeNotified = false;
  private messageHandlers: MessageHandler[] = [];
  private closeHandlers: CloseHandler[] = [];

  constructor(private socket: any) {
    socket.on("data", (chunk: any) => this.handleData(chunk));
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

  private sendPong(payload: any): void {
    this.sendFrame(0xA, payload);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      this.socket.write(Buffer.concat([this.makeHeader(0, 0x8), Buffer.alloc(0)]));
    } catch {
      this.safeDestroy();
      this.notifyClose();
      return;
    }

    this.socket.end();
  }

  private makeHeader(length: number, opcode: number): any {
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

  private handleData(chunk: any): void {
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

  private readFrame(): { fin: boolean; opcode: number; payload: any } | null {
    if (this.buffer.length < 2) return null;

    const first = this.buffer[0];
    const second = this.buffer[1];

    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

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

    let mask: any = null;

    if (this.buffer.length < offset + 4) return null;
    mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;

    if (length > MAX_FRAME_PAYLOAD_LENGTH) {
      throw new Error("WebSocket frame too large");
    }

    if (this.buffer.length < offset + length) return null;

    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);

    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }

    return { fin, opcode, payload };
  }

  private handleFrame(frame: { fin: boolean; opcode: number; payload: any }): void {
    switch (frame.opcode) {
      case 0x0:
        this.handleContinuation(frame);
        return;
      case 0x1:
        this.handleTextFrame(frame);
        return;
      case 0x8:
        if (!frame.fin || frame.payload.length > 125) {
          throw new Error("Invalid close frame");
        }
        this.close();
        return;
      case 0x9:
        if (!frame.fin || frame.payload.length > 125) {
          throw new Error("Invalid ping frame");
        }
        this.sendPong(frame.payload);
        return;
      case 0xA:
        if (!frame.fin || frame.payload.length > 125) {
          throw new Error("Invalid pong frame");
        }
        return;
      default:
        throw new Error("Unsupported WebSocket opcode");
    }
  }

  private handleTextFrame(frame: { fin: boolean; opcode: number; payload: any }): void {
    if (this.fragmentedOpcode !== null) {
      throw new Error("Unexpected text frame during fragmented message");
    }

    if (frame.fin) {
      this.emitMessage(frame.payload.toString("utf8"));
      return;
    }

    this.fragmentedOpcode = frame.opcode;
    this.fragmentedPayloads = [frame.payload];
    this.fragmentedPayloadLength = frame.payload.length;
  }

  private handleContinuation(frame: { fin: boolean; opcode: number; payload: any }): void {
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

    this.emitMessage(payload.toString("utf8"));
  }

  private emitMessage(message: string): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  private sendFrame(opcode: number, payload: any): void {
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
  private server = createServer();
  private connectionHandlers: ((connection: WebSocketConnection) => void)[] = [];

  constructor(private port: number, private host: string) {}

  onConnection(handler: (connection: WebSocketConnection) => void): void {
    this.connectionHandlers.push(handler);
  }

  listen(): Promise<void> {
    this.server.on("upgrade", (req: any, socket: any) => {
      const key = req.headers["sec-websocket-key"];

      if (!key) {
        socket.destroy();
        return;
      }

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
      this.connectionHandlers.forEach((fn) => fn(connection));
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, resolve);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
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
