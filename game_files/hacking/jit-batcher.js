const HACK_SCRIPT = "scripts/hacking/jit-hack.js";
const GROW_SCRIPT = "scripts/hacking/jit-grow.js";
const WEAKEN_SCRIPT = "scripts/hacking/jit-weaken.js";

const WORKERS = [HACK_SCRIPT, GROW_SCRIPT, WEAKEN_SCRIPT];

const DEFAULT_HACK_FRACTION = 0.10;
const DEFAULT_SPACING_MS = 25;
const LAUNCH_LEAD_MS = 8;
const PREP_MONEY_RATIO = 0.99;
const PREP_SECURITY_TOLERANCE = 0.05;
const MAX_PREP_GROW_THREADS = 500;
const MAX_PREP_WEAKEN_THREADS = 500;
const LOOP_SLEEP_MS = 5;
const PREP_WAIT_MS = 1000;
const BATCH_STATUS_EARLY_COUNT = 3;
const BATCH_STATUS_INTERVAL = 25;

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
  /** @type {{ batchId: number, name: string, script: string, threads: number, duration: number, finishAt: number, offset: number, launchAt: number }[]} */
  const eventQueue = [];
  /** @type {number[]} */
  const activeBatchFinishes = [];

  const fillEventQueue = () => {
    while (activeBatchFinishes.length < maxActiveBatches) {
      const money = ns.getServerMoneyAvailable(target);
      const maxMoney = ns.getServerMaxMoney(target);
      const security = ns.getServerSecurityLevel(target);
      const minSecurity = ns.getServerMinSecurityLevel(target);

      const badlyDrifted = money < maxMoney * 0.80 || security > minSecurity + 5;
      if (badlyDrifted) {
        ns.print("Target drifted too far. Re-prepping.");
        return false;
      }

      const currentBatch = batchId++;
      if (shouldLogBatchStatus(currentBatch)) {
        ns.print(`plan batch=${currentBatch} hack=0ms weaken-hack=${spacing}ms grow=${spacing * 2}ms weaken-grow=${spacing * 3}ms`);
        ns.print(
          `batch=${currentBatch} money=${formatMoneyPercent(ns, target)} sec=${security.toFixed(2)}/${minSecurity.toFixed(2)} hackFraction=${formatPercent(hackFraction)}`
        );
      }

      const batchEvents = createBatchEvents(currentBatch, nextHackFinish, spacing, plan);
      if (!batchEvents) {
        ns.print(`invalid batch timing batch=${currentBatch}`);
        return false;
      }

      eventQueue.push(...batchEvents);
      activeBatchFinishes.push(batchEvents[3].finishAt);
      nextHackFinish += batchInterval;
    }

    return true;
  };

  while (true) {
    pruneFinishedBatchFinishes(activeBatchFinishes, Date.now());
    if (!fillEventQueue()) {
      return hackFraction;
    }
    eventQueue.sort((a, b) => a.launchAt - b.launchAt || a.batchId - b.batchId || a.offset - b.offset);

    const nextEvent = eventQueue[0];
    if (!nextEvent) {
      await ns.sleep(LOOP_SLEEP_MS);
      continue;
    }

    const wait = nextEvent.launchAt - Date.now();
    if (wait > 0) {
      await ns.sleep(Math.min(wait, LOOP_SLEEP_MS));
      continue;
    }

    eventQueue.shift();

    if (Date.now() > nextEvent.finishAt - nextEvent.duration + 250) {
      ns.print(`stale event batch=${nextEvent.batchId} event=${nextEvent.name}`);
      return hackFraction;
    }

    if (nextEvent.batchId < BATCH_STATUS_EARLY_COUNT) {
      ns.print(
        `launch batch=${nextEvent.batchId} event=${nextEvent.name} threads=${nextEvent.threads} startsIn=${Math.max(0, Math.round(nextEvent.launchAt - Date.now()))} finishesIn=${Math.max(0, Math.round(nextEvent.finishAt - Date.now()))} offset=${nextEvent.offset}`
      );
    }

    const availableBefore = availableDistributedThreads(ns, workers, nextEvent.script);
    const result = runDistributed(ns, workers, nextEvent.script, nextEvent.threads, [
      target,
      nextEvent.finishAt,
      nextEvent.duration,
      `${nextEvent.batchId}:${nextEvent.name}`
    ]);

    if (!result.ok) {
      ns.print(
        `missed ${nextEvent.name} batch=${nextEvent.batchId} need=${result.requested} available=${availableBefore} scriptRam=${ns.getScriptRam(nextEvent.script, "home")}`
      );
      return Math.max(0.01, hackFraction * 0.9);
    }

    await ns.sleep(LOOP_SLEEP_MS);
  }
}

/**
 * @param {number} batchId
 * @param {number} hackFinish
 * @param {number} spacing
 * @param {ReturnType<typeof makeBatchPlan>} plan
 * @returns {Array<{ batchId: number, name: string, script: string, threads: number, duration: number, finishAt: number, offset: number, launchAt: number }>|null}
 */
function createBatchEvents(batchId, hackFinish, spacing, plan) {
  const events = [
    {
      batchId,
      name: "hack",
      script: HACK_SCRIPT,
      threads: plan.hackThreads,
      duration: plan.hackTime,
      finishAt: hackFinish,
      offset: 0
    },
    {
      batchId,
      name: "weaken-hack",
      script: WEAKEN_SCRIPT,
      threads: plan.weakHackThreads,
      duration: plan.weakenTime,
      finishAt: hackFinish + spacing,
      offset: spacing
    },
    {
      batchId,
      name: "grow",
      script: GROW_SCRIPT,
      threads: plan.growThreads,
      duration: plan.growTime,
      finishAt: hackFinish + spacing * 2,
      offset: spacing * 2
    },
    {
      batchId,
      name: "weaken-grow",
      script: WEAKEN_SCRIPT,
      threads: plan.weakGrowThreads,
      duration: plan.weakenTime,
      finishAt: hackFinish + spacing * 3,
      offset: spacing * 3
    }
  ];

  if (!(events[0].finishAt < events[1].finishAt && events[1].finishAt < events[2].finishAt && events[2].finishAt < events[3].finishAt)) {
    return null;
  }

  for (const event of events) {
    event.launchAt = event.finishAt - event.duration - LAUNCH_LEAD_MS;
  }

  return events;
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
      const requiredWeakenThreads = Math.ceil((security - minSecurity) / ns.weakenAnalyze(1));
      const availableWeakenThreads = availableDistributedThreads(ns, workers, WEAKEN_SCRIPT);
      const weakenChunkThreads = Math.min(requiredWeakenThreads, availableWeakenThreads, MAX_PREP_WEAKEN_THREADS);

      if (weakenChunkThreads <= 0) {
        ns.print(`prep weaken waiting for RAM required=${requiredWeakenThreads} available=${availableWeakenThreads}`);
        await ns.sleep(PREP_WAIT_MS);
        continue;
      }

      ns.print(`prep weaken sec=${security.toFixed(2)}/${minSecurity.toFixed(2)} threads=${weakenChunkThreads}`);

      const weakenResult = runDistributed(ns, workers, WEAKEN_SCRIPT, weakenChunkThreads, [
        target,
        Date.now() + ns.getWeakenTime(target),
        ns.getWeakenTime(target),
        "prep-weaken"
      ]);

      if (!weakenResult.ok) {
        ns.print(`prep weaken waiting for RAM required=${weakenResult.requested} available=${availableWeakenThreads}`);
        await ns.sleep(PREP_WAIT_MS);
        continue;
      }

      await ns.sleep(ns.getWeakenTime(target) + 250);
      continue;
    }

    if (needsGrow) {
      const safeMoney = Math.max(1, money);
      const multiplier = maxMoney / safeMoney;
      const requiredGrowThreads = Math.ceil(ns.growthAnalyze(target, multiplier));
      const availableGrowThreads = availableDistributedThreads(ns, workers, GROW_SCRIPT);
      const growChunkThreads = Math.min(requiredGrowThreads, availableGrowThreads, MAX_PREP_GROW_THREADS);

      if (growChunkThreads <= 0) {
        ns.print(`prep grow waiting for RAM required=${requiredGrowThreads} available=${availableGrowThreads}`);
        await ns.sleep(PREP_WAIT_MS);
        continue;
      }

      ns.print(`prep grow money=${formatMoneyPercent(ns, target)} threads=${growChunkThreads}`);

      const growResult = runDistributed(ns, workers, GROW_SCRIPT, growChunkThreads, [
        target,
        Date.now() + ns.getGrowTime(target),
        ns.getGrowTime(target),
        "prep-grow"
      ]);

      if (!growResult.ok) {
        ns.print(`prep grow waiting for RAM required=${growResult.requested} available=${availableGrowThreads}`);
        await ns.sleep(PREP_WAIT_MS);
        continue;
      }

      await ns.sleep(ns.getGrowTime(target) + 250);

      const growSecurity = ns.growthAnalyzeSecurity(growChunkThreads, target);
      const requiredWeakenThreads = Math.ceil(growSecurity / ns.weakenAnalyze(1));
      const availableWeakenThreads = availableDistributedThreads(ns, workers, WEAKEN_SCRIPT);
      const weakenChunkThreads = Math.min(requiredWeakenThreads, availableWeakenThreads, MAX_PREP_WEAKEN_THREADS);

      if (weakenChunkThreads <= 0) {
        ns.print(`prep post-grow weaken waiting for RAM required=${requiredWeakenThreads} available=${availableWeakenThreads}`);
        await ns.sleep(PREP_WAIT_MS);
        continue;
      }

      ns.print(`prep post-grow weaken threads=${weakenChunkThreads}`);

      const weakenResult = runDistributed(ns, workers, WEAKEN_SCRIPT, weakenChunkThreads, [
        target,
        Date.now() + ns.getWeakenTime(target),
        ns.getWeakenTime(target),
        "prep-grow-weaken"
      ]);

      if (!weakenResult.ok) {
        ns.print(`prep post-grow weaken waiting for RAM required=${weakenResult.requested} available=${availableWeakenThreads}`);
        await ns.sleep(PREP_WAIT_MS);
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
 * @returns {{ ok: boolean, pids: number[], requested: number, launched: number }}
 */
function runDistributed(ns, workers, script, totalThreads, args) {
  const requested = Math.max(0, Math.ceil(totalThreads));
  const pids = [];

  if (requested === 0) {
    return { ok: true, pids, requested, launched: 0 };
  }

  const scriptRam = ns.getScriptRam(script, "home");
  if (!Number.isFinite(scriptRam) || scriptRam <= 0) {
    return { ok: false, pids, requested, launched: 0 };
  }

  if (!canRunDistributed(ns, workers, script, requested)) {
    return { ok: false, pids, requested, launched: 0 };
  }

  let remaining = requested;
  let launched = 0;
  let failed = false;
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
    if (pid === 0) {
      failed = true;
      continue;
    }

    pids.push(pid);
    remaining -= threads;
    launched += threads;
  }

  if (remaining > 0) {
    failed = true;
  }

  return {
    ok: !failed && launched === requested,
    pids,
    requested,
    launched
  };
}

/**
 * @param {NS} ns
 * @param {string[]} workers
 * @param {string} script
 * @param {number} totalThreads
 */
function canRunDistributed(ns, workers, script, totalThreads) {
  const requested = Math.max(0, Math.ceil(totalThreads));
  if (requested === 0) {
    return true;
  }

  const scriptRam = ns.getScriptRam(script, "home");
  if (!Number.isFinite(scriptRam) || scriptRam <= 0) {
    return false;
  }

  return availableDistributedThreads(ns, workers, script) >= requested;
}

/**
 * @param {NS} ns
 * @param {string[]} workers
 * @param {string} script
 */
function availableDistributedThreads(ns, workers, script) {
  const scriptRam = ns.getScriptRam(script, "home");
  if (!Number.isFinite(scriptRam) || scriptRam <= 0) {
    return 0;
  }

  return workers.reduce((total, host) => total + Math.floor(freeRam(ns, host) / scriptRam), 0);
}

/**
 * @param {number[]} finishTimes
 * @param {number} now
 */
function pruneFinishedBatchFinishes(finishTimes, now) {
  let writeIndex = 0;

  for (const finishAt of finishTimes) {
    if (finishAt > now) {
      finishTimes[writeIndex++] = finishAt;
    }
  }

  finishTimes.length = writeIndex;
}

/**
 * @param {number} batchId
 */
function shouldLogBatchStatus(batchId) {
  return batchId < BATCH_STATUS_EARLY_COUNT || batchId % BATCH_STATUS_INTERVAL === 0;
}

/**
 * @param {NS} ns
 * @param {string} target
 */
function formatMoneyPercent(ns, target) {
  const maxMoney = ns.getServerMaxMoney(target);
  if (!Number.isFinite(maxMoney) || maxMoney <= 0) {
    return "0.0%";
  }

  return formatPercent(ns.getServerMoneyAvailable(target) / maxMoney);
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

      const levelPenalty = required > level / 2 ? 0.5 : 1;
      const score = (maxMoney / Math.max(1, minSecurity)) / Math.max(1, weakenTime) * levelPenalty;

      return { host, score };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.host ?? "";
}

/** @param {NS} ns */
function rootAvailableServers(ns) {
  const cracks = [
    ["BruteSSH.exe", ns.brutessh],
    ["FTPCrack.exe", ns.ftpcrack],
    ["relaySMTP.exe", ns.relaysmtp],
    ["HTTPWorm.exe", ns.httpworm],
    ["SQLInject.exe", ns.sqlinject]
  ];

  const availableCracks = cracks.filter(([file]) => ns.fileExists(String(file), "home"));

  for (const host of getHosts(ns)) {
    if (host === "home" || ns.hasRootAccess(host)) {
      continue;
    }

    if (availableCracks.length < ns.getServerNumPortsRequired(host)) {
      continue;
    }

    for (const [, fn] of availableCracks) {
      try {
        fn(host);
      } catch {
        // Ignore already-open or unavailable edge cases.
      }
    }

    try {
      ns.nuke(host);
    } catch {
      // Ignore failures. The next loop will retry.
    }
  }
}

/** @param {NS} ns */
function getHosts(ns) {
  const seen = new Set(["home"]);
  const stack = ["home"];

  while (stack.length > 0) {
    const current = stack.pop();

    for (const next of ns.scan(current)) {
      if (seen.has(next)) {
        continue;
      }

      seen.add(next);
      stack.push(next);
    }
  }

  return [...seen];
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
