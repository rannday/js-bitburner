import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { BitburnerRemoteApi } from "./bitburner.js";

const helpText = [
  "Commands:",
  "  help",
  "  quit",
  "  exit",
  "  servers",
  "  files [server]",
  "  get <server> <filename>",
  "  push <server> <remote-filename> <local-path>",
  "  delete <server> <filename>",
  "  metadata <server> <filename>",
  "  all-files [server]",
  "  all-metadata [server]",
  "  ram <server> <filename>",
  "  defs",
  "  save"
].join("\n");

export class BitburnerRepl {
  constructor(private getApi: () => BitburnerRemoteApi | null) {}

  async run(): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    let exiting = false;

    rl.on("SIGINT", () => {
      exiting = true;
      rl.close();
    });

    try {
      while (true) {
        let line: string;

        try {
          line = await rl.question("bb> ");
        } catch {
          if (exiting) {
            return;
          }

          throw new Error("Readline closed");
        }

        const tokens = parseCommandLine(line);
        if (tokens.length === 0) {
          continue;
        }

        const [command, ...args] = tokens;

        if (command === "help") {
          process.stdout.write(`${helpText}\n`);
          continue;
        }

        if (command === "quit" || command === "exit") {
          exiting = true;
          rl.close();
          return;
        }

        const api = this.getApi();
        if (!api) {
          process.stdout.write("Bitburner is not connected.\n");
          continue;
        }

        try {
          await this.runCommand(api, command, args);
        } catch (error) {
          process.stderr.write(`${String(error)}\n`);
        }
      }
    } finally {
      rl.close();
    }
  }

  private async runCommand(api: BitburnerRemoteApi, command: string, args: string[]): Promise<void> {
    switch (command) {
      case "servers": {
        const value = await api.getAllServers();
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
        return;
      }

      case "files": {
        const server = args[0] ?? "home";
        const value = await api.getFileNames(server);
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
        return;
      }

      case "get": {
        const [server, filename] = args;
        if (!server || !filename) {
          throw new Error("get requires <server> <filename>");
        }

        const value = await api.getFile(filename, server);
        process.stdout.write(value);
        return;
      }

      case "push": {
        const [server, remoteFilename, localPath] = args;
        if (!server || !remoteFilename || !localPath) {
          throw new Error("push requires <server> <remote-filename> <local-path>");
        }

        const content = await readFile(localPath, "utf8");
        const value = await api.pushFile(remoteFilename, content, server);
        process.stdout.write(`${value}\n`);
        return;
      }

      case "delete": {
        const [server, filename] = args;
        if (!server || !filename) {
          throw new Error("delete requires <server> <filename>");
        }

        const value = await api.deleteFile(filename, server);
        process.stdout.write(`${value}\n`);
        return;
      }

      case "metadata": {
        const [server, filename] = args;
        if (!server || !filename) {
          throw new Error("metadata requires <server> <filename>");
        }

        const value = await api.getFileMetadata(filename, server);
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
        return;
      }

      case "all-files": {
        const server = args[0] ?? "home";
        const value = await api.getAllFiles(server);
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
        return;
      }

      case "all-metadata": {
        const server = args[0] ?? "home";
        const value = await api.getAllFileMetadata(server);
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
        return;
      }

      case "ram": {
        const [server, filename] = args;
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
        process.stdout.write('Unknown command. Type "help" for commands.\n');
    }
  }
}

function parseCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === " " || char === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += "\\";
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
