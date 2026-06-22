import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { BitburnerRemoteApi } from "./bitburner.js";

const helpText = [
  "Commands:",
  "  help",
  "  quit",
  "  exit",
  "  servers",
  "  files [server]",
  "  get <server> <filename> [local-path]",
  "  push <server> <remote-filename> <local-path>",
  "  delete <server> <filename>",
  "  metadata <server> <filename>",
  "  all-files <local-path>",
  "  all-files <server> <local-path>",
  "  all-metadata [server]",
  "  ram <server> <filename>",
  "  defs [local-path]",
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
          return;
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
        const [server, filename, localPath] = args;
        if (!server || !filename) {
          throw new Error("get requires <server> <filename> [local-path]");
        }
        if (args.length > 3) {
          throw new Error("get requires <server> <filename> [local-path]");
        }

        const value = await api.getFile(filename, server);
        if (localPath) {
          await writeTextFile(localPath, value);
          process.stdout.write(`Wrote ${localPath}\n`);
          return;
        }

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
        if (args.length === 0) {
          process.stdout.write("all-files can return a large payload. Use: all-files [server] <local-path>\n");
          return;
        }
        if (args.length > 2) {
          process.stdout.write("all-files can return a large payload. Use: all-files [server] <local-path>\n");
          return;
        }

        const server = args.length === 1 ? "home" : args[0];
        const localPath = args.length === 1 ? args[0] : args[1];

        if (!localPath) {
          process.stdout.write("all-files can return a large payload. Use: all-files [server] <local-path>\n");
          return;
        }

        const value = await api.getAllFiles(server);
        await writeTextFile(localPath, `${JSON.stringify(value, null, 2)}\n`);
        process.stdout.write(`Wrote ${localPath}\n`);
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
        if (args.length > 1) {
          throw new Error("defs requires [local-path]");
        }

        const value = await api.getDefinitionFile();
        const localPath = args[0];
        if (localPath) {
          await writeTextFile(localPath, value);
          process.stdout.write(`Wrote ${localPath}\n`);
          return;
        }

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

async function writeTextFile(path: string, content: string): Promise<void> {
  const parent = dirname(path);

  if (parent !== "" && parent !== ".") {
    await mkdir(parent, { recursive: true });
  }

  await writeFile(path, content, "utf8");
}
