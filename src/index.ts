import { BitburnerRemoteApi } from "./bitburner.js";
import { BitburnerRepl } from "./repl.js";
import { WebSocketConnection, WebSocketServer } from "./ws-server.js";

const host = "127.0.0.1";
const port = 12525;

let api: BitburnerRemoteApi | null = null;
let currentConnection: WebSocketConnection | null = null;
let currentConnectionId = 0;
let readyResolve: (() => void) | null = null;
let shuttingDown = false;

const ready = new Promise<void>((resolve) => {
  readyResolve = resolve;
});

const server = new WebSocketServer(port, host);

server.onConnection((connection) => {
  currentConnectionId += 1;
  const connectionId = currentConnectionId;
  const previousConnection = currentConnection;

  if (previousConnection) {
    previousConnection.close();
  }

  currentConnection = connection;
  api = new BitburnerRemoteApi(connection);
  process.stdout.write('Bitburner connected.\nType "help" for commands.\n');

  if (readyResolve) {
    readyResolve();
    readyResolve = null;
  }

  connection.onClose(() => {
    if (connectionId !== currentConnectionId) {
      return;
    }

    currentConnection = null;
    api = null;

    if (!shuttingDown) {
      process.stdout.write("Bitburner disconnected.\nWaiting for Bitburner to reconnect...\n");
    }
  });
});

try {
  await server.listen();
  process.stdout.write(`Listening on ws://${host}:${port}\n`);
  process.stdout.write("Waiting for Bitburner to connect...\n");

  await ready;

  const repl = new BitburnerRepl(() => api);
  await repl.run();
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
} finally {
  shuttingDown = true;

  const connection = currentConnection as WebSocketConnection | null;
  if (connection) {
    connection.close();
    currentConnection = null;
  }

  try {
    await server.close();
  } catch (error) {
    if (process.exitCode === undefined) {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
