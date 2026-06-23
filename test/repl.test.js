import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCommand, UsageError, parseCommandLine } from "../dist/repl.js";

test("command line parsing", async (t) => {
  await t.test("unterminated quote rejected", () => {
    assert.throws(() => parseCommandLine('push home "missing'), UsageError);
    assert.throws(() => parseCommandLine("push home 'missing"), UsageError);
  });

  await t.test("quoted args parsed correctly", () => {
    assert.deepEqual(
      parseCommandLine('cmd "two words" \'three words\' plain\\ text'),
      ["cmd", "two words", "three words", "plain text"]
    );
  });

  await t.test("escaped chars parsed correctly", () => {
    assert.deepEqual(
      parseCommandLine('cmd one\\ two "quoted \\"value\\""'),
      ["cmd", "one two", 'quoted "value"']
    );
  });
});

test("save command behavior", async (t) => {
  await t.test("save requires a path", async () => {
    const harness = createHarness();
    const api = createApi();

    await executeCommand(api, "save", [], harness.io);

    assert.equal(harness.stdout(), "save writes large data. Use: save <local-path>\n");
    assert.equal(harness.stderr(), "");
    assert.equal(api.calls.getSaveFile, 0);
  });

  await t.test("save writes JSON rather than printing blob", async () => {
    const harness = createHarness();
    const api = createApi({
      saveValue: {
        identifier: "save-id",
        binary: false,
        save: "blob-data"
      }
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "js-bitburner-"));
    const file = path.join(dir, "save.json");

    await executeCommand(api, "save", [file], harness.io);

    const content = await readFile(file, "utf8");
    assert.equal(
      content,
      `${JSON.stringify({ identifier: "save-id", binary: false, save: "blob-data" }, null, 2)}\n`
    );
    assert.equal(harness.stdout(), `Wrote ${file}\n`);
    assert.equal(api.calls.getSaveFile, 1);
  });

  await t.test("usage errors reject bad arguments", async () => {
    const harness = createHarness();
    const api = createApi();

    await assert.rejects(() => executeCommand(api, "get", ["home"], harness.io), UsageError);

    assert.equal(harness.stdout(), "");
    assert.equal(harness.stderr(), "");
  });
});

test("sync command behavior", async (t) => {
  await t.test("sync requires at least server and local-dir", async () => {
    const harness = createHarness();
    const api = createApi();

    await assert.rejects(() => executeCommand(api, "sync", ["home"], harness.io), UsageError);
    await assert.rejects(() => executeCommand(api, "sync", [], harness.io), UsageError);
    assert.equal(harness.stdout(), "");
    assert.equal(harness.stderr(), "");
    assert.equal(api.calls.pushFile, 0);
  });

  await t.test("sync rejects too many args", async () => {
    const harness = createHarness();
    const api = createApi();

    await assert.rejects(
      () => executeCommand(api, "sync", ["home", "scripts", "extra", "too-much"], harness.io),
      UsageError
    );
  });

  await t.test("sync rejects unknown flags besides --clean", async () => {
    const harness = createHarness();
    const api = createApi();

    await assert.rejects(
      () => executeCommand(api, "sync", ["home", "scripts", "--bogus"], harness.io),
      UsageError
    );
  });

  await t.test("sync parses --clean and still uploads", async () => {
    const harness = createHarness();
    const api = createApi({
      servers: [
        { hostname: "home", hasAdminRights: true, purchasedByPlayer: false },
        { hostname: "foodnstuff", hasAdminRights: true, purchasedByPlayer: false }
      ],
      filesByServer: {
        home: ["money.js", "scripts/hacking/jit-batcher.js", "keep.txt"],
        foodnstuff: ["scripts/director.js", "keep.txt"]
      }
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "js-bitburner-sync-clean-"));
    const localDir = path.join(root, "game_files");

    await mkdir(path.join(localDir, "hacking"), { recursive: true });
    await writeFile(path.join(localDir, "hacking", "jit-hack.js"), "hack.js", "utf8");

    await executeCommand(api, "sync", ["home", localDir, "scripts", "--clean"], harness.io);

    assert.deepEqual(api.deleteFileArgs, [
      { filename: "money.js", server: "home" },
      { filename: "scripts/hacking/jit-batcher.js", server: "home" },
      { filename: "scripts/director.js", server: "foodnstuff" }
    ]);
    assert.deepEqual(api.pushFileArgs, [
      {
        filename: "scripts/hacking/jit-hack.js",
        content: "hack.js",
        server: "home"
      }
    ]);
    assert.ok(api.events.findIndex((event) => event[0] === "deleteFile") < api.events.findIndex((event) => event[0] === "pushFile"));
  });

  await t.test("sync preserves relative paths and prefixes remote-dir", async () => {
    const harness = createHarness();
    const api = createApi();
    const root = await mkdtemp(path.join(os.tmpdir(), "js-bitburner-sync-"));
    const localDir = path.join(root, "game_files");

    await mkdir(path.join(localDir, "hacking", "nested"), { recursive: true });
    await writeFile(path.join(localDir, "hacking", "jit-hack.js"), "hack.js", "utf8");
    await writeFile(path.join(localDir, "hacking", "nested", "jit-grow.ts"), "grow.ts", "utf8");
    await writeFile(path.join(localDir, "hacking", "nested", "ignored.md"), "ignore me", "utf8");

    await executeCommand(api, "sync", ["home", localDir, "scripts"], harness.io);

    assert.deepEqual(api.pushFileArgs, [
      {
        filename: "scripts/hacking/jit-hack.js",
        content: "hack.js",
        server: "home"
      },
      {
        filename: "scripts/hacking/nested/jit-grow.ts",
        content: "grow.ts",
        server: "home"
      }
    ]);
    assert.equal(
      harness.stdout(),
      [
        `OK ${pathToDisplay(path.join(localDir, "hacking", "jit-hack.js"))} -> home:scripts/hacking/jit-hack.js`,
        `OK ${pathToDisplay(path.join(localDir, "hacking", "nested", "jit-grow.ts"))} -> home:scripts/hacking/nested/jit-grow.ts`,
        "Synced 2 file(s)."
      ].join("\n") + "\n"
    );
    assert.equal(harness.stderr(), "");
  });

  await t.test("sync ignores unsupported file extensions", async () => {
    const harness = createHarness();
    const api = createApi();
    const root = await mkdtemp(path.join(os.tmpdir(), "js-bitburner-sync-empty-"));
    const localDir = path.join(root, "files");

    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "note.md"), "nope", "utf8");
    await writeFile(path.join(localDir, "image.png"), "nope", "utf8");

    await executeCommand(api, "sync", ["home", localDir], harness.io);

    assert.equal(api.calls.pushFile, 0);
    assert.equal(harness.stdout(), `No uploadable files found in ${localDir}\n`);
    assert.equal(harness.stderr(), "");
  });
});

test("clean command behavior", async (t) => {
  await t.test("clean accepts zero or one server arg", async () => {
    const harness = createHarness();
    const api = createApi({
      servers: [
        { hostname: "home", hasAdminRights: true, purchasedByPlayer: false },
        { hostname: "foodnstuff", hasAdminRights: true, purchasedByPlayer: false },
        { hostname: "n00dles", hasAdminRights: false, purchasedByPlayer: false }
      ],
      filesByServer: {
        home: [
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
          "scripts/util/cleanup.js",
          "keep.txt",
          ".lit",
          "contract.cct"
        ],
        foodnstuff: [
          "scripts/director.js",
          "scripts/manager.js",
          "scripts/tinyhack.js",
          "scripts/tinygrow.js",
          "scripts/tinyweaken.js",
          "unrelated.js"
        ],
        n00dles: ["money.js", "scripts/hacking/jit-batcher.js"]
      }
    });

    await executeCommand(api, "clean", [], harness.io);

    assert.deepEqual(api.deleteFileArgs, [
      { filename: "money.js", server: "home" },
      { filename: "worker.js", server: "home" },
      { filename: "scripts/worm.js", server: "home" },
      { filename: "scripts/director.js", server: "home" },
      { filename: "scripts/manager.js", server: "home" },
      { filename: "scripts/tinyhack.js", server: "home" },
      { filename: "scripts/tinygrow.js", server: "home" },
      { filename: "scripts/tinyweaken.js", server: "home" },
      { filename: "scripts/hacking/jit-batcher.js", server: "home" },
      { filename: "scripts/hacking/jit-hack.js", server: "home" },
      { filename: "scripts/hacking/jit-grow.js", server: "home" },
      { filename: "scripts/hacking/jit-weaken.js", server: "home" },
      { filename: "scripts/util/cleanup.js", server: "home" },
      { filename: "scripts/director.js", server: "foodnstuff" },
      { filename: "scripts/manager.js", server: "foodnstuff" },
      { filename: "scripts/tinyhack.js", server: "foodnstuff" },
      { filename: "scripts/tinygrow.js", server: "foodnstuff" },
      { filename: "scripts/tinyweaken.js", server: "foodnstuff" }
    ]);
    assert.equal(api.getFileNamesArgs.includes("n00dles"), false);
    assert.equal(api.deleteFileArgs.some(({ filename }) => filename === "keep.txt"), false);
    assert.equal(api.deleteFileArgs.some(({ filename }) => filename === ".lit"), false);
    assert.equal(api.deleteFileArgs.some(({ filename }) => filename === "contract.cct"), false);
  });

  await t.test("clean with server only touches that server", async () => {
    const harness = createHarness();
    const api = createApi({
      servers: [
        { hostname: "home", hasAdminRights: true, purchasedByPlayer: false },
        { hostname: "foodnstuff", hasAdminRights: true, purchasedByPlayer: false }
      ],
      filesByServer: {
        home: ["money.js", "scripts/hacking/jit-batcher.js"],
        foodnstuff: ["scripts/director.js", "keep.txt"]
      }
    });

    await executeCommand(api, "clean", ["home"], harness.io);

    assert.deepEqual(api.deleteFileArgs, [
      { filename: "money.js", server: "home" },
      { filename: "scripts/hacking/jit-batcher.js", server: "home" }
    ]);
    assert.equal(api.getFileNamesArgs.includes("foodnstuff"), false);
  });

  await t.test("clean rejects too many args", async () => {
    const harness = createHarness();
    const api = createApi();

    await assert.rejects(() => executeCommand(api, "clean", ["home", "extra"], harness.io), UsageError);
  });
});

function createHarness() {
  const buffers = {
    stdout: "",
    stderr: ""
  };

  return {
    io: {
      stdout(value) {
        buffers.stdout += value;
      },
      stderr(value) {
        buffers.stderr += value;
      }
    },
    stdout() {
      return buffers.stdout;
    },
    stderr() {
      return buffers.stderr;
    }
  };
}

function createApi(options = {}) {
  const {
    saveValue = { identifier: "id", binary: false, save: "blob" },
    servers = [],
    filesByServer = {}
  } = options;

  return {
    calls: {
      getSaveFile: 0,
      getAllServers: 0,
      getFileNames: 0,
      pushFile: 0,
      deleteFile: 0
    },
    events: [],
    getFileNamesArgs: [],
    deleteFileArgs: [],
    pushFileArgs: [],
    async getSaveFile() {
      this.calls.getSaveFile += 1;
      return saveValue;
    },
    async getAllServers() {
      this.calls.getAllServers += 1;
      this.events.push(["getAllServers"]);
      return servers;
    },
    async getFileNames(server) {
      this.calls.getFileNames += 1;
      this.getFileNamesArgs.push(server);
      this.events.push(["getFileNames", server]);
      return filesByServer[server] ?? [];
    },
    async pushFile(filename, content, server) {
      this.calls.pushFile += 1;
      this.pushFileArgs.push({
        filename,
        content,
        server
      });
      this.events.push(["pushFile", server, filename]);
      return "OK";
    },
    async deleteFile(filename, server) {
      this.calls.deleteFile += 1;
      this.deleteFileArgs.push({
        filename,
        server
      });
      this.events.push(["deleteFile", server, filename]);
      return "OK";
    }
  };
}

function pathToDisplay(filePath) {
  return filePath.split(path.sep).join("/");
}
