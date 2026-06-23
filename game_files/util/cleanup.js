const PROCESS_PATHS = new Set([
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

const FILE_PATHS = new Set([
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

const PROTECTED_HOME_FILE_PATHS = new Set([
  "scripts/hacking/jit-batcher.js",
  "scripts/hacking/jit-hack.js",
  "scripts/hacking/jit-grow.js",
  "scripts/hacking/jit-weaken.js",
  "scripts/util/cleanup.js"
]);

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const options = parseArgs(ns.args);
  if (!options) {
    ns.tprint("Usage: run scripts/util/cleanup.js [--files] [--include-home-files] [--dry-run] [--target <hostname>]");
    return;
  }

  const hosts = collectHosts(ns);
  const targetHosts = options.target ? hosts.filter((host) => host === options.target) : hosts;

  if (options.target && targetHosts.length === 0) {
    ns.tprint(`No known host named ${options.target}.`);
    return;
  }

  let killed = 0;
  let deleted = 0;

  for (const host of targetHosts) {
    if (!ns.hasRootAccess(host)) {
      ns.tprint(`skip ${host} (no admin rights)`);
      continue;
    }

    const processes = ns.ps(host);
    for (const process of processes) {
      if (!shouldKillProcess(process, ns.pid)) {
        continue;
      }

      if (options.dryRun) {
        ns.tprint(`would kill ${host}:${process.pid} ${process.filename}`);
        continue;
      }

      if (ns.kill(process.pid)) {
        ns.tprint(`killed ${host}:${process.pid} ${process.filename}`);
        killed += 1;
      }
    }

    if (!options.files) {
      continue;
    }

    for (const file of FILE_PATHS) {
      if (host === "home" && PROTECTED_HOME_FILE_PATHS.has(file) && !options.includeHomeFiles) {
        ns.tprint(`${options.dryRun ? "would skip" : "skip"} protected home:${file}`);
        continue;
      }

      if (!ns.fileExists(file, host)) {
        continue;
      }

      if (options.dryRun) {
        ns.tprint(`would delete ${host}:${file}`);
        continue;
      }

      if (ns.rm(file, host)) {
        ns.tprint(`deleted ${host}:${file}`);
        deleted += 1;
      }
    }
  }

  ns.tprint(`Cleanup complete. killed=${killed} deleted=${deleted}`);
}

/**
 * @param {NS} ns
 * @returns {string[]}
 */
function collectHosts(ns) {
  const visited = new Set();
  const queue = ["home"];

  while (queue.length > 0) {
    const host = queue.shift();
    if (!host || visited.has(host)) {
      continue;
    }

    visited.add(host);

    for (const neighbor of ns.scan(host)) {
      if (!visited.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}

/**
 * @param {NS.ProcessInfo} process
 * @param {number} selfPid
 * @returns {boolean}
 */
function shouldKillProcess(process, selfPid) {
  if (process.pid === selfPid) {
    return false;
  }

  return PROCESS_PATHS.has(process.filename);
}

/**
 * @param {unknown[]} args
 * @returns {{ files: boolean; dryRun: boolean; target: string | null } | null}
 */
function parseArgs(args) {
  let files = false;
  let includeHomeFiles = false;
  let dryRun = false;
  let target = null;

  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);

    if (value === "--files") {
      files = true;
      continue;
    }

    if (value === "--include-home-files") {
      includeHomeFiles = true;
      continue;
    }

    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (value === "--target") {
      if (index + 1 >= args.length) {
        return null;
      }

      target = String(args[index + 1]);
      index += 1;
      continue;
    }

    return null;
  }

  return {
    files,
    includeHomeFiles,
    dryRun,
    target
  };
}
