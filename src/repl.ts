import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
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
  "  save <local-path>",
  "  clean [server]",
  "  sync <server> <local-dir> [remote-dir] [--clean]"
].join("\n");

const cleanupFilePaths = new Set([
  "money.js",
  "worker.js",
  "scripts/worm.js",
  "scripts/director.js",
  "scripts/manager.js",
  "scripts/tinyhack.js",
  "scripts/tinygrow.js",
  "scripts/tinyweaken.js",
  "scripts/hacking/jit-batcher.js",
  "scripts/hacking/jit-hack.js",
  "scripts/hacking/jit-grow.js",
  "scripts/hacking/jit-weaken.js",
  "scripts/util/cleanup.js"
]);

const processCleanupNote =
  "Remote API cannot kill running scripts. Run scripts/util/cleanup.js in-game for process cleanup.";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type CommandIO = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

const defaultCommandIO: CommandIO = {
  stdout: (value) => {
    process.stdout.write(value);
  },
  stderr: (value) => {
    process.stderr.write(value);
  }
};

export class BitburnerRepl {
  constructor(private getApi: () => BitburnerRemoteApi | null) {}

  async run(): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.on("SIGINT", () => {
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

        try {
          const tokens = parseCommandLine(line);
          if (tokens.length === 0) {
            continue;
          }

          const [command, ...args] = tokens;

          if (command === "help") {
            defaultCommandIO.stdout(`${helpText}\n`);
            continue;
          }

          if (command === "quit" || command === "exit") {
            rl.close();
            return;
          }

          const api = this.getApi();
          if (!api) {
            defaultCommandIO.stdout("Bitburner is not connected.\n");
            continue;
          }

          await executeCommand(api, command, args, defaultCommandIO);
        } catch (error) {
          if (error instanceof UsageError) {
            defaultCommandIO.stderr(`${error.message}\n`);
            continue;
          }

          defaultCommandIO.stderr(`${String(error)}\n`);
        }
      }
    } finally {
      rl.close();
    }
  }
}

export async function executeCommand(
  api: BitburnerRemoteApi,
  command: string,
  args: string[],
  io: CommandIO = defaultCommandIO
): Promise<void> {
  switch (command) {
    case "servers": {
      const value = await api.getAllServers();
      io.stdout(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "files": {
      const server = args[0] ?? "home";
      const value = await api.getFileNames(server);
      io.stdout(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "get": {
      const [server, filename, localPath] = args;
      if (!server || !filename || args.length > 3) {
        throw new UsageError("get requires <server> <filename> [local-path]");
      }

      const value = await api.getFile(filename, server);
      if (localPath) {
        await writeTextFile(localPath, value);
        io.stdout(`Wrote ${localPath}\n`);
        return;
      }

      io.stdout(value);
      return;
    }

    case "push": {
      const [server, remoteFilename, localPath] = args;
      if (!server || !remoteFilename || !localPath || args.length > 3) {
        throw new UsageError("push requires <server> <remote-filename> <local-path>");
      }

      const content = await readFile(localPath, "utf8");
      const value = await api.pushFile(remoteFilename, content, server);
      io.stdout(`${value}\n`);
      return;
    }

    case "delete": {
      const [server, filename] = args;
      if (!server || !filename || args.length > 2) {
        throw new UsageError("delete requires <server> <filename>");
      }

      const value = await api.deleteFile(filename, server);
      io.stdout(`${value}\n`);
      return;
    }

    case "metadata": {
      const [server, filename] = args;
      if (!server || !filename || args.length > 2) {
        throw new UsageError("metadata requires <server> <filename>");
      }

      const value = await api.getFileMetadata(filename, server);
      io.stdout(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "all-files": {
      if (args.length === 0 || args.length > 2) {
        throw new UsageError("all-files requires <local-path> or [server] <local-path>");
      }

      const server = args.length === 1 ? "home" : args[0];
      const localPath = args.length === 1 ? args[0] : args[1];

      const value = await api.getAllFiles(server);
      await writeTextFile(localPath, `${JSON.stringify(value, null, 2)}\n`);
      io.stdout(`Wrote ${localPath}\n`);
      return;
    }

    case "all-metadata": {
      if (args.length > 1) {
        throw new UsageError("all-metadata takes at most one optional server");
      }

      const server = args[0] ?? "home";
      const value = await api.getAllFileMetadata(server);
      io.stdout(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "ram": {
      const [server, filename] = args;
      if (!server || !filename || args.length > 2) {
        throw new UsageError("ram requires <server> <filename>");
      }

      const value = await api.calculateRam(filename, server);
      io.stdout(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }

    case "defs": {
      if (args.length > 1) {
        throw new UsageError("defs takes at most one optional local path");
      }

      const value = await api.getDefinitionFile();
      const localPath = args[0];
      if (localPath) {
        await writeTextFile(localPath, value);
        io.stdout(`Wrote ${localPath}\n`);
        return;
      }

      io.stdout(value);
      return;
    }

    case "save": {
      if (args.length > 1) {
        throw new UsageError("save requires <local-path>");
      }

      const localPath = args[0];
      if (!localPath) {
        io.stdout("save writes large data. Use: save <local-path>\n");
        return;
      }

      const value = await api.getSaveFile();
      await writeJsonFile(localPath, value);
      io.stdout(`Wrote ${localPath}\n`);
      return;
    }

    case "clean": {
      if (args.length > 1) {
        throw new UsageError("clean accepts at most one optional server");
      }

      await cleanRemoteFiles(api, args[0], io);
      return;
    }

    case "sync": {
      const { server, localDir, remoteDir, clean } = parseSyncArgs(args);

      if (clean) {
        io.stdout(`${processCleanupNote}\n`);
        await cleanRemoteFiles(api, undefined, io);
      }

      const files = await listUploadFiles(localDir);

      if (files.length === 0) {
        io.stdout(`No uploadable files found in ${localDir}\n`);
        return;
      }

      const remotePrefix = remoteDir ? trimSlashes(remoteDir) : "";
      let synced = 0;

      for (const filePath of files) {
        const content = await readFile(filePath, "utf8");
        const localRelative = toBitburnerPath(join(localDir, relative(localDir, filePath)));
        const remoteRelative = toBitburnerPath(relative(localDir, filePath));
        const remoteFilename = remotePrefix ? `${remotePrefix}/${remoteRelative}` : remoteRelative;

        await api.pushFile(remoteFilename, content, server);
        io.stdout(`OK ${localRelative} -> ${server}:${remoteFilename}\n`);
        synced += 1;
      }

      io.stdout(`Synced ${synced} file(s).\n`);
      return;
    }

    default:
      io.stdout('Unknown command. Type "help" for commands.\n');
  }
}

export function parseCommandLine(line: string): string[] {
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

  if (quote !== null) {
    throw new UsageError("Unterminated quoted string.");
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseSyncArgs(args: string[]): {
  server: string;
  localDir: string;
  remoteDir: string | null;
  clean: boolean;
} {
  const positional: string[] = [];
  let clean = false;

  for (const arg of args) {
    if (arg === "--clean") {
      if (clean) {
        throw new UsageError("sync accepts --clean at most once");
      }

      clean = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new UsageError("sync only supports --clean as an optional flag");
    }

    positional.push(arg);
  }

  if (positional.length < 2 || positional.length > 3) {
    throw new UsageError("sync requires <server> <local-dir> [remote-dir]");
  }

  return {
    server: positional[0],
    localDir: positional[1],
    remoteDir: positional[2] ?? null,
    clean
  };
}

async function cleanRemoteFiles(api: BitburnerRemoteApi, serverName: string | undefined, io: CommandIO): Promise<void> {
  const servers = await api.getAllServers();
  const selectedServers = serverName ? servers.filter((server) => server.hostname === serverName) : servers;

  if (serverName && selectedServers.length === 0) {
    io.stdout(`No known server named ${serverName}.\n`);
    return;
  }

  let cleanedServers = 0;
  let deletedFiles = 0;

  for (const server of selectedServers) {
    if (!server.hasAdminRights) {
      continue;
    }

    const files = await api.getFileNames(server.hostname);
    const staleFiles = files.filter((file) => cleanupFilePaths.has(file));

    if (staleFiles.length === 0) {
      continue;
    }

    cleanedServers += 1;

    for (const file of staleFiles) {
      await api.deleteFile(file, server.hostname);
      io.stdout(`deleted ${server.hostname}:${file}\n`);
      deletedFiles += 1;
    }
  }

  if (deletedFiles === 0) {
    io.stdout("No stale automation files found.\n");
  } else {
    io.stdout(`Cleaned ${deletedFiles} file(s) on ${cleanedServers} server(s).\n`);
  }

  io.stdout(`${processCleanupNote}\n`);
}

async function writeTextFile(path: string, content: string): Promise<void> {
  const parent = dirname(path);

  if (parent !== "" && parent !== ".") {
    await mkdir(parent, { recursive: true });
  }

  await writeFile(path, content, "utf8");
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function listUploadFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  await walkUploadFiles(root, results);
  results.sort((left, right) => left.localeCompare(right));
  return results;
}

async function walkUploadFiles(currentPath: string, results: string[]): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walkUploadFiles(fullPath, results);
      continue;
    }

    if (entry.isFile() && isUploadableFile(entry.name)) {
      results.push(fullPath);
    }
  }
}

function isUploadableFile(filePath: string): boolean {
  switch (extname(filePath).toLowerCase()) {
    case ".js":
    case ".ts":
    case ".txt":
    case ".script":
    case ".json":
      return true;
    default:
      return false;
  }
}

function toBitburnerPath(filePath: string): string {
  return filePath.split(/[\\/]/u).join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^[/\\]+|[/\\]+$/gu, "");
}
