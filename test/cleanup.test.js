import { strict as assert } from "node:assert";
import test from "node:test";
import { main as cleanupMain } from "../game_files/util/cleanup.js";

test("cleanup script behavior", async (t) => {
  await t.test("default run kills only matching processes and deletes no files", async () => {
    const harness = createCleanupHarness({
      filesByHost: {
        home: [
          "money.js",
          "scripts/worm.js",
          "scripts/hacking/jit-batcher.js",
          "scripts/util/cleanup.js"
        ]
      }
    });

    await cleanupMain(harness.ns([]));

    assert.equal(harness.rmCalls.length, 0);
    assert.equal(harness.logs.at(-1), "Cleanup complete. killed=0 deleted=0");
  });

  await t.test("files mode protects home managed scripts", async () => {
    const harness = createCleanupHarness({
      filesByHost: {
        home: [
          "money.js",
          "worker.js",
          "scripts/worm.js",
          "scripts/director.js",
          "alpha.txt",
          "scripts/hacking/jit-batcher.js",
          "scripts/hacking/jit-hack.js",
          "scripts/hacking/jit-grow.js",
          "scripts/hacking/jit-weaken.js",
          "scripts/util/cleanup.js"
        ]
      }
    });

    await cleanupMain(harness.ns(["--files"]));

    assert.deepEqual(harness.rmCalls, [
      ["money.js", "home"],
      ["worker.js", "home"],
      ["scripts/worm.js", "home"],
      ["scripts/director.js", "home"]
    ]);
    assert.equal(harness.rmCalls.some(([file]) => file === "alpha.txt"), false);
    assert.ok(harness.logs.includes("skip protected home:scripts/hacking/jit-batcher.js"));
    assert.ok(harness.logs.includes("skip protected home:scripts/hacking/jit-hack.js"));
    assert.ok(harness.logs.includes("skip protected home:scripts/hacking/jit-grow.js"));
    assert.ok(harness.logs.includes("skip protected home:scripts/hacking/jit-weaken.js"));
    assert.ok(harness.logs.includes("skip protected home:scripts/util/cleanup.js"));
  });

  await t.test("files mode can include home managed scripts when requested", async () => {
    const harness = createCleanupHarness({
      filesByHost: {
        home: [
          "money.js",
          "scripts/worm.js",
          "scripts/hacking/jit-batcher.js",
          "scripts/util/cleanup.js"
        ]
      }
    });

    await cleanupMain(harness.ns(["--files", "--include-home-files"]));

    assert.deepEqual(harness.rmCalls, [
      ["money.js", "home"],
      ["scripts/worm.js", "home"],
      ["scripts/hacking/jit-batcher.js", "home"],
      ["scripts/util/cleanup.js", "home"]
    ]);
    assert.equal(harness.logs.some((line) => line.startsWith("skip protected home:")), false);
  });

  await t.test("dry-run reports protected home skips", async () => {
    const harness = createCleanupHarness({
      filesByHost: {
        home: [
          "money.js",
          "scripts/hacking/jit-batcher.js"
        ]
      }
    });

    await cleanupMain(harness.ns(["--files", "--dry-run"]));

    assert.equal(harness.rmCalls.length, 0);
    assert.ok(harness.logs.includes("would delete home:money.js"));
    assert.ok(harness.logs.includes("would skip protected home:scripts/hacking/jit-batcher.js"));
  });
});

function createCleanupHarness({ filesByHost = {}, rootAccessHosts = ["home"] } = {}) {
  const logs = [];
  const rmCalls = [];

  return {
    logs,
    rmCalls,
    ns(args) {
      return {
        args,
        pid: 123,
        disableLog() {},
        tprint(value) {
          logs.push(value);
        },
        getHostname() {
          return "home";
        },
        hasRootAccess(host) {
          return rootAccessHosts.includes(host);
        },
        scan(host) {
          return host === "home" ? [] : [];
        },
        ps() {
          return [];
        },
        kill() {
          return false;
        },
        fileExists(file, host) {
          return (filesByHost[host] ?? []).includes(file);
        },
        rm(file, host) {
          rmCalls.push([file, host]);
          return true;
        }
      };
    }
  };
}
