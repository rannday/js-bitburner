import { readFile } from "node:fs/promises";
import { BitburnerRemoteApi } from "./bitburner.js";
import { WebSocketConnection, WebSocketServer } from "./ws-server.js";

const host = "127.0.0.1";
const port = 12525;
const usage = [
  "Usage:",
  "  node dist/index.js servers",
  "  node dist/index.js files [server]",
  "  node dist/index.js get <server> <filename>",
  "  node dist/index.js push <server> <remote-filename> <local-path>",
  "  node dist/index.js delete <server> <filename>",
  "  node dist/index.js metadata <server> <filename>",
  "  node dist/index.js all-files [server]",
  "  node dist/index.js all-metadata [server]",
  "  node dist/index.js ram <server> <filename>",
  "  node dist/index.js defs",
  "  node dist/index.js save"
].join("\n");

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
} else {
  const server = new WebSocketServer(port, host);
  const connectionPromise = new Promise<WebSocketConnection>((resolve) => {
    server.onConnection(resolve);
  });

  try {
    await server.listen();
    process.stdout.write(`Listening on ws://${host}:${port}\n`);

    const connection = await connectionPromise;
    const api = new BitburnerRemoteApi(connection);

    try {
      await runCommand(api, args);
    } finally {
      connection.close();
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await server.close();
    } catch (error) {
      if (process.exitCode === undefined) {
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 1;
      }
    }
  }
}

async function runCommand(api: BitburnerRemoteApi, args: string[]): Promise<void> {
  const [command, ...rest] = args;

  switch (command) {
    case "servers": {
      const value = await api.getAllServers();
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "files": {
      const server = rest[0] ?? "home";
      const value = await api.getFileNames(server);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "get": {
      const [server, filename] = rest;
      if (!server || !filename) {
        throw new Error("get requires <server> <filename>");
      }

      const value = await api.getFile(filename, server);
      process.stdout.write(value);
      return;
    }

    case "push": {
      const [server, remoteFilename, localPath] = rest;
      if (!server || !remoteFilename || !localPath) {
        throw new Error("push requires <server> <remote-filename> <local-path>");
      }

      const content = await readFile(localPath, "utf8");
      const value = await api.pushFile(remoteFilename, content, server);
      process.stdout.write(`${value}\n`);
      return;
    }

    case "delete": {
      const [server, filename] = rest;
      if (!server || !filename) {
        throw new Error("delete requires <server> <filename>");
      }

      const value = await api.deleteFile(filename, server);
      process.stdout.write(`${value}\n`);
      return;
    }

    case "metadata": {
      const [server, filename] = rest;
      if (!server || !filename) {
        throw new Error("metadata requires <server> <filename>");
      }

      const value = await api.getFileMetadata(filename, server);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "all-files": {
      const server = rest[0] ?? "home";
      const value = await api.getAllFiles(server);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "all-metadata": {
      const server = rest[0] ?? "home";
      const value = await api.getAllFileMetadata(server);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "ram": {
      const [server, filename] = rest;
      if (!server || !filename) {
        throw new Error("ram requires <server> <filename>");
      }

      const value = await api.calculateRam(filename, server);
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "defs": {
      const value = await api.getDefinitionFile();
      process.stdout.write(value);
      return;
    }

    case "save": {
      const value = await api.getSaveFile();
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
