import { WebSocketServer } from "./ws-server.js";
import { BitburnerRemoteApi } from "./bitburner.js";

const host = "127.0.0.1";
const port = 12525;

let api: BitburnerRemoteApi | null = null;

const server = new WebSocketServer(port, host);

server.onConnection(async (connection) => {
  process.stdout.write("Bitburner connected\n");

  api = new BitburnerRemoteApi(connection);

  try {
    const servers = await api.getAllServers();
    process.stdout.write(`Servers: ${servers.length}\n`);

    const files = await api.getFileNames("home");
    process.stdout.write(`Files on home: ${files.length}\n`);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
  }

  connection.onClose(() => {
    process.stdout.write("Bitburner disconnected\n");
    api = null;
  });
});

await server.listen();

process.stdout.write(`Listening on ws://${host}:${port}\n`);
process.stdout.write("Set Bitburner Remote API to hostname 127.0.0.1, port 12525, Use wss OFF.\n");
