import { strict as assert } from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
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
      identifier: "save-id",
      binary: false,
      save: "blob-data"
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

function createApi(saveValue = { identifier: "id", binary: false, save: "blob" }) {
  return {
    calls: {
      getSaveFile: 0
    },
    async getSaveFile() {
      this.calls.getSaveFile += 1;
      return saveValue;
    }
  };
}
