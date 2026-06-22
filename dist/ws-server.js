import { createServer } from "node:http";
import { createHash } from "node:crypto";
export class WebSocketConnection {
    socket;
    buffer = Buffer.alloc(0);
    messageHandlers = [];
    closeHandlers = [];
    constructor(socket) {
        this.socket = socket;
        socket.on("data", (chunk) => this.handleData(chunk));
        socket.on("close", () => this.closeHandlers.forEach((fn) => fn()));
        socket.on("error", () => this.closeHandlers.forEach((fn) => fn()));
    }
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    onClose(handler) {
        this.closeHandlers.push(handler);
    }
    sendText(text) {
        const payload = Buffer.from(text, "utf8");
        const header = this.makeHeader(payload.length);
        this.socket.write(Buffer.concat([header, payload]));
    }
    close() {
        this.socket.end();
    }
    makeHeader(length) {
        if (length < 126) {
            return Buffer.from([0x81, length]);
        }
        if (length <= 0xffff) {
            const header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 126;
            header.writeUInt16BE(length, 2);
            return header;
        }
        const header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
        return header;
    }
    handleData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
            const frame = this.readFrame();
            if (!frame)
                return;
            if (frame.opcode === 0x8) {
                this.close();
                return;
            }
            if (frame.opcode === 0x1) {
                const text = frame.payload.toString("utf8");
                this.messageHandlers.forEach((fn) => fn(text));
            }
        }
    }
    readFrame() {
        if (this.buffer.length < 2)
            return null;
        const first = this.buffer[0];
        const second = this.buffer[1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (this.buffer.length < offset + 2)
                return null;
            length = this.buffer.readUInt16BE(offset);
            offset += 2;
        }
        else if (length === 127) {
            if (this.buffer.length < offset + 8)
                return null;
            const bigLength = this.buffer.readBigUInt64BE(offset);
            if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error("WebSocket frame too large");
            }
            length = Number(bigLength);
            offset += 8;
        }
        let mask = null;
        if (masked) {
            if (this.buffer.length < offset + 4)
                return null;
            mask = this.buffer.subarray(offset, offset + 4);
            offset += 4;
        }
        if (this.buffer.length < offset + length)
            return null;
        const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
        this.buffer = this.buffer.subarray(offset + length);
        if (masked) {
            for (let i = 0; i < payload.length; i++) {
                payload[i] ^= mask[i % 4];
            }
        }
        return { opcode, payload };
    }
}
export class WebSocketServer {
    port;
    host;
    server = createServer();
    connectionHandlers = [];
    constructor(port, host) {
        this.port = port;
        this.host = host;
    }
    onConnection(handler) {
        this.connectionHandlers.push(handler);
    }
    listen() {
        this.server.on("upgrade", (req, socket) => {
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
}
