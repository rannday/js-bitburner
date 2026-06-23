const HACK_SCRIPT = "scripts/hacking/jit-hack.js";
const GROW_SCRIPT = "scripts/hacking/jit-grow.js";
const WEAKEN_SCRIPT = "scripts/hacking/jit-weaken.js";

const WORKERS = [HACK_SCRIPT, GROW_SCRIPT, WEAKEN_SCRIPT];

const DEFAULT_HACK_FRACTION = 0.10;
const DEFAULT_SPACING_MS = 25;
const LAUNCH_LEAD_MS = 8;
const PREP_MONEY_RATIO = 0.99;
const PREP_SECURITY_TOLERANCE = 0.05;
const LOOP_SLEEP_MS = 5;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  const requestedTarget = ns.args[0] ? String(ns.args[0]) : "";
  let hackFraction = clamp(Number(ns.args[1] ?? DEFAULT_HACK_FRACTION), 0.01, 0.90);
  const spacing = Math.max(5, Number(ns.args[2] ?? DEFAULT_SPACING_MS));

  while (true) {
    rootAvailableServers(ns);

    const hosts = getHosts(ns);
    const workers = hosts.filter((host) => ns.hasRootAccess(host) && ns.getServerMaxRam(host) > 0);

    await deployWorkers(ns, workers);

    const target = requestedTarget || chooseTarget(ns, hosts);
    if (!target) {
      ns.print("No valid target found.");
      await ns.sleep(10_000);
      continue;
    }

    ns.clearLog();
    ns.print(`target=${target}`);
    ns.print(`hackFraction=${formatPercent(hackFraction)}`);
    ns.print(`spacing=${spacing}ms`);
    ns.print(`workers=${workers.length}`);

    await prepTarget(ns, target, workers);

    const plan = makeBatchPlan(ns, target, hackFraction, spacing);
    if (!plan) {
      ns.print("Could not build batch plan. Retrying.");
      await ns.sleep(5_000);
      continue;
    }

    ns.print(`hackThreads=${plan.hackThreads}`);
    ns.print(`growThreads=${plan.growThreads}`);
    ns.print(`weakHackThreads=${plan.weakHackThreads}`);
    ns.print(`weakGrowThreads=${plan.weakGrowThreads}`);
    ns.print(`hackTime=${Math.round(plan.hackTime)}ms`);
    ns.print(`growTime=${Math.round(plan.growTime)}ms`);
    ns.print(`weakenTime=${Math.round(plan.weakenTime)}ms`);

    hackFraction = await runJit(ns, target, workers, plan, spacing, hackFraction);
  }
}

/**
 * @param {NS} ns
 * @param {string} target
 * @param {string[]} workers
 * @param {ReturnType<typeof makeBatchPlan>} plan
 * @param {number} spacing
 * @param {number} hackFraction
 * @returns {Promise<number>}
 */
async function runJit(ns, target, workers, plan, spacing, hackFraction) {
  if (!plan) {
    return hackFraction;
  }

  const batchInterval = spacing * 4;
  const calculatedMaxActiveBatches = Math.floor((plan.weakenTime + spacing * 4) / batchInterval);
  const maxActiveBatches = clamp(calculatedMaxActiveBatches, 1, 200);

  let batchId = 0;
  let nextHackFinish = Date.now() + plan.weakenTime + spacing * 8;
  /** @type {number[]} */
  const activeBatchFinishes = [];

  while (true) {
    pruneFinished(activeBatchFinishes);
    while (activeBatchFinishes.length >= maxActiveBatches) {
      const wait = activeBatchFinishes[0] - Date.now();
      if (wait > 0) {
        await ns.sleep(wait);
      } else {
        await ns.sleep(LOOP_SLEEP_MS);
      }

      pruneFinished(activeBatchFinishes);
    }

    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);

    const badlyDrifted = money < maxMoney * 0.80 || security > minSecurity + 5;

    if (badlyDrifted) {
      ns.print("Target drifted too far. Re-prepping.");
      return hackFraction;
    }

    const currentBatch = batchId++;
    const batchDoneAt = nextHackFinish + spacing * 3;
    const events = [
      {
        name: "weaken-hack",
        script: WEAKEN_SCRIPT,
        threads: plan.weakHackThreads,
        duration: plan.weakenTime,
        finishAt: nextHackFinish + spacing
      },
      {
        name: "hack",
        script: HACK_SCRIPT,
        threads: plan.hackThreads,
        duration: plan.hackTime,
        finishAt: nextHackFinish
      },
      {
        name: "grow",
        script: GROW_SCRIPT,
        threads: plan.growThreads,
        duration: plan.growTime,
        finishAt: nextHackFinish + spacing * 2
      },
      {
        name: "weaken-grow",
        script: WEAKEN_SCRIPT,
        threads: plan.weakGrowThreads,
        duration: plan.weakenTime,
        finishAt: nextHackFinish + spacing * 3
      }
    ].sort((a, b) => launchAt(a) - launchAt(b));

    let failed = false;

    for (const event of events) {
      const wait = launchAt(event) - Date.now();
      if (wait > 0) {
        await ns.sleep(wait);
      }

      const launched = launchDistributed(ns, workers, event.script, event.threads, [
        target,
        event.finishAt,
        event.duration,
        `${currentBatch}:${event.name}`
      ], event.name, String(currentBatch));

      if (!launched) {
        failed = true;
        break;
      }
    }

    if (failed) {
      return Math.max(0.01, hackFraction * 0.90);
    }

    activeBatchFinishes.push(batchDoneAt);
    nextHackFinish += batchInterval;

    if ((currentBatch + 1) % 25 === 0) {
      ns.print(
        `batch=${currentBatch} money=${formatPercent(maxMoney <= 0 ? 0 : money / maxMoney)} sec=${formatFixed(security)}/${formatFixed(minSecurity)} hackFraction=${formatPercent(hackFraction)}`
      );
    }

    await ns.sleep(LOOP_SLEEP_MS);
  }
}

/**
 * @param {{ finishAt: number, duration: number }} event
 */
function launchAt(event) {
  return event.finishAt - event.duration - LAUNCH_LEAD_MS;
}

/**
 * @param {NS} ns
 * @param {string} target
 * @param {number} hackFraction
 * @param {number} spacing
 */
function makeBatchPlan(ns, target, hackFraction, spacing) {
  const hackTime = ns.getHackTime(target);
  const growTime = ns.getGrowTime(target);
  const weakenTime = ns.getWeakenTime(target);

  const hackPct = ns.hackAnalyze(target);
  if (!Number.isFinite(hackPct) || hackPct <= 0) {
    return null;
  }

  const hackThreads = Math.max(1, Math.floor(hackFraction / hackPct));
  const actualHackFraction = clamp(hackThreads * hackPct, 0.001, 0.95);

  const growMultiplier = 1 / (1 - actualHackFraction);
  const growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growMultiplier)));

  const hackSecurity = ns.hackAnalyzeSecurity(hackThreads, target);
  const growSecurity = ns.growthAnalyzeSecurity(growThreads, target);
  const weakenPerThread = ns.weakenAnalyze(1);

  const weakHackThreads = Math.max(1, Math.ceil(hackSecurity / weakenPerThread));
  const weakGrowThreads = Math.max(1, Math.ceil(growSecurity / weakenPerThread));

  if ([hackThreads, growThreads, weakHackThreads, weakGrowThreads].some((value) => !Number.isFinite(value))) {
    return null;
  }

  return {
    hackTime,
    growTime,
    weakenTime,
    hackThreads,
    growThreads,
    weakHackThreads,
    weakGrowThreads,
    spacing
  };
}

/**
 * @param {NS} ns
 * @param {string} target
 * @param {string[]} workers
 */
async function prepTarget(ns, target, workers) {
  while (true) {
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);

    const needsWeaken = security > minSecurity + PREP_SECURITY_TOLERANCE;
    const needsGrow = money < maxMoney * PREP_MONEY_RATIO;

    if (!needsWeaken && !needsGrow) {
      ns.print("prep complete");
      return;
    }

    if (needsWeaken) {
      const weakenThreads = Math.ceil((security - minSecurity) / ns.weakenAnalyze(1));
      ns.print(`prep weaken sec=${formatFixed(security)}/${formatFixed(minSecurity)} threads=${weakenThreads}`);

      if (!launchDistributed(ns, workers, WEAKEN_SCRIPT, weakenThreads, [
        target,
        Date.now() + ns.getWeakenTime(target),
        ns.getWeakenTime(target),
        "prep-weaken"
      ], "weaken", "prep")) {
        await ns.sleep(5_000);
        continue;
      }

      await ns.sleep(ns.getWeakenTime(target) + 250);
      continue;
    }

    if (needsGrow) {
      const safeMoney = Math.max(1, money);
      const multiplier = maxMoney / safeMoney;
      const growThreads = Math.ceil(ns.growthAnalyze(target, multiplier));
      const growSecurity = ns.growthAnalyzeSecurity(growThreads, target);
      const weakenThreads = Math.ceil(growSecurity / ns.weakenAnalyze(1));

      ns.print(`prep grow money=${formatPercent(maxMoney <= 0 ? 0 : money / maxMoney)} threads=${growThreads}`);

      if (!launchDistributed(ns, workers, GROW_SCRIPT, growThreads, [
        target,
        Date.now() + ns.getGrowTime(target),
        ns.getGrowTime(target),
        "prep-grow"
      ], "grow", "prep")) {
        await ns.sleep(5_000);
        continue;
      }

      await ns.sleep(ns.getGrowTime(target) + 250);

      ns.print(`prep post-grow weaken threads=${weakenThreads}`);

      if (!launchDistributed(ns, workers, WEAKEN_SCRIPT, weakenThreads, [
        target,
        Date.now() + ns.getWeakenTime(target),
        ns.getWeakenTime(target),
        "prep-grow-weaken"
      ], "weaken", "prep")) {
        await ns.sleep(5_000);
        continue;
      }

      await ns.sleep(ns.getWeakenTime(target) + 250);
    }
  }
}

/**
 * @param {NS} ns
 * @param {string[]} hosts
 */
async function deployWorkers(ns, hosts) {
  for (const host of hosts) {
    if (host === "home") {
      continue;
    }

    await ns.scp(WORKERS, host, "home");
  }
}

/**
 * @param {NS} ns
 * @param {string[]} workers
 * @param {string} script
 * @param {number} totalThreads
 * @param {Array<string | number>} args
 * @param {string} event
 * @param {string} batchId
 * @returns {boolean}
 */
function launchDistributed(ns, workers, script, totalThreads, args, event, batchId) {
  if (!canRunDistributed(ns, workers, script, totalThreads)) {
    ns.print(`missed ${event} batch=${batchId} need=${Math.ceil(totalThreads)} available=${availableDistributedThreads(ns, workers, script)} scriptRam=${ns.getScriptRam(script, "home")}`);
    return false;
  }

  const pids = runDistributed(ns, workers, script, totalThreads, args);
  if (pids.length === 0) {
    ns.print(`missed ${event} batch=${batchId} need=${Math.ceil(totalThreads)} available=${availableDistributedThreads(ns, workers, script)} scriptRam=${ns.getScriptRam(script, "home")}`);
    return false;
  }

  return true;
}

/**
 * @param {NS} ns
 * @param {string[]} workers
 * @param {string} script
 * @param {number} totalThreads
 * @param {Array<string | number>} args
 * @returns {number[]}
 */
function runDistributed(ns, workers, script, totalThreads, args) {
  let remaining = Math.ceil(totalThreads);
  const pids = [];
  const scriptRam = ns.getScriptRam(script, "home");

  const sorted = [...workers].sort((a, b) => freeRam(ns, b) - freeRam(ns, a));

  for (const host of sorted) {
    if (remaining <= 0) {
      break;
    }

    const availableThreads = Math.floor(freeRam(ns, host) / scriptRam);
    const threads = Math.min(remaining, availableThreads);

    if (threads <= 0) {
      continue;
    }

    const pid = ns.exec(script, host, threads, ...args);
    if (pid !== 0) {
      pids.push(pid);
      remaining -= threads;
    }
  }

  return remaining === 0 ? pids : [];
}

/**
 * @param {NS} ns
 * @param {string[]} workers
 * @param {string} script
 * @returns {number}
 */
function availableDistributedThreads(ns, workers, script) {
  const scriptRam = ns.getScriptRam(script, "home");
  if (!Number.isFinite(scriptRam) || scriptRam <= 0) {
    return 0;
  }

  let available = 0;
  for (const host of workers) {
    available += Math.floor(freeRam(ns, host) / scriptRam);
  }

  return available;
}

/**
 * @param {NS} ns
 * @param {string[]} workers
 * @param {string} script
 * @param {number} totalThreads
 * @returns {boolean}
 */
function canRunDistributed(ns, workers, script, totalThreads) {
  return availableDistributedThreads(ns, workers, script) >= totalThreads;
}

/**
 * @param {number[]} finishTimes
 */
function pruneFinished(finishTimes) {
  const now = Date.now();
  while (finishTimes.length > 0 && finishTimes[0] <= now) {
    finishTimes.shift();
  }
}

/**
 * @param {NS} ns
 * @param {string} host
 */
function freeRam(ns, host) {
  return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

/**
 * @param {NS} ns
 */
function rootAvailableServers(ns) {
  for (const host of getHosts(ns)) {
    if (host === "home" || ns.hasRootAccess(host)) {
      continue;
    }

    tryRootServer(ns, host);
  }
}

/**
 * @param {NS} ns
 * @returns {string[]}
 */
function getHosts(ns) {
  const seen = new Set(["home"]);
  const queue = ["home"];

  while (queue.length > 0) {
    const host = queue.shift();
    if (!host) {
      continue;
    }

    for (const next of ns.scan(host)) {
      if (seen.has(next)) {
        continue;
      }

      seen.add(next);
      queue.push(next);
    }
  }

  return [...seen];
}

/**
 * @param {NS} ns
 * @param {string} host
 */
function tryRootServer(ns, host) {
  try {
    if (ns.fileExists("BruteSSH.exe", "home")) {
      ns.brutessh(host);
    }
    if (ns.fileExists("FTPCrack.exe", "home")) {
      ns.ftpcrack(host);
    }
    if (ns.fileExists("relaySMTP.exe", "home")) {
      ns.relaysmtp(host);
    }
    if (ns.fileExists("HTTPWorm.exe", "home")) {
      ns.httpworm(host);
    }
    if (ns.fileExists("SQLInject.exe", "home")) {
      ns.sqlinject(host);
    }

    if (ns.getServerNumPortsRequired(host) <= countAvailablePortOpeners(ns)) {
      ns.nuke(host);
    }
  } catch {
    // Ignore failed rooting attempts and keep moving.
  }
}

/**
 * @param {NS} ns
 * @returns {number}
 */
function countAvailablePortOpeners(ns) {
  let count = 0;
  if (ns.fileExists("BruteSSH.exe", "home")) {
    count += 1;
  }
  if (ns.fileExists("FTPCrack.exe", "home")) {
    count += 1;
  }
  if (ns.fileExists("relaySMTP.exe", "home")) {
    count += 1;
  }
  if (ns.fileExists("HTTPWorm.exe", "home")) {
    count += 1;
  }
  if (ns.fileExists("SQLInject.exe", "home")) {
    count += 1;
  }
  return count;
}

/**
 * @param {NS} ns
 * @param {string[]} hosts
 */
function chooseTarget(ns, hosts) {
  const level = ns.getHackingLevel();

  const candidates = hosts
    .filter((host) => ns.hasRootAccess(host))
    .filter((host) => ns.getServerMaxMoney(host) > 0)
    .filter((host) => ns.getServerRequiredHackingLevel(host) <= level)
    .map((host) => {
      const maxMoney = ns.getServerMaxMoney(host);
      const minSecurity = ns.getServerMinSecurityLevel(host);
      const weakenTime = ns.getWeakenTime(host);
      const required = ns.getServerRequiredHackingLevel(host);

      const levelPenalty = required > level / 2 ? 0.50 : 1;
      const score = (maxMoney / Math.max(1, minSecurity)) / Math.max(1, weakenTime) * levelPenalty;

      return { host, score };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.host ?? "";
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatFixed(value) {
  return value.toFixed(2);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
