import { createServer } from "node:http";
import { createHash } from "node:crypto";

type MessageHandler = (message: string) => void;
type CloseHandler = () => void;

export class WebSocketConnection {
  private buffer = Buffer.alloc(0);
  private fragmentedOpcode: number | null = null;
  private fragmentedPayloads: any[] = [];
  private isClosed = false;
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
    const payload = Buffer.from(text, "utf8");
    const header = this.makeHeader(payload.length, 0x1);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private sendPong(payload: any): void {
    const header = this.makeHeader(payload.length, 0xA);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(): void {
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
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const frame = this.readFrame();
      if (!frame) return;

      if (frame.opcode === 0x8) {
        this.close();
        return;
      }

      if (frame.opcode === 0x9) {
        this.sendPong(frame.payload);
        continue;
      }

      if (frame.opcode === 0xA) {
        continue;
      }

      if (frame.opcode === 0x1) {
        if (this.fragmentedOpcode !== null) {
          this.socket.destroy();
          return;
        }

        if (frame.fin) {
          const text = frame.payload.toString("utf8");
          this.messageHandlers.forEach((fn) => fn(text));
          continue;
        }

        this.fragmentedOpcode = frame.opcode;
        this.fragmentedPayloads = [frame.payload];
        continue;
      }

      if (frame.opcode === 0x0) {
        if (this.fragmentedOpcode === null) {
          this.socket.destroy();
          return;
        }

        this.fragmentedPayloads.push(frame.payload);

        if (frame.fin) {
          const payload = Buffer.concat(this.fragmentedPayloads);
          this.fragmentedOpcode = null;
          this.fragmentedPayloads = [];
          const text = payload.toString("utf8");
          this.messageHandlers.forEach((fn) => fn(text));
        }
        continue;
      }

      this.socket.destroy();
      return;
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

    let mask: any = null;

    if (masked) {
      if (this.buffer.length < offset + 4) return null;
      mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (this.buffer.length < offset + length) return null;

    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);

    if (masked) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    return { fin, opcode, payload };
  }

  private notifyClose(): void {
    if (this.isClosed) return;
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
