const HACK_SCRIPT = "scripts/jit-hack.js";
const GROW_SCRIPT = "scripts/jit-grow.js";
const WEAKEN_SCRIPT = "scripts/jit-weaken.js";

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
  const hackFraction = clamp(Number(ns.args[1] ?? DEFAULT_HACK_FRACTION), 0.01, 0.90);
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

    await runJit(ns, target, workers, plan, spacing);
  }
}

/**
 * @param {NS} ns
 * @param {string} target
 * @param {string[]} workers
 * @param {ReturnType<typeof makeBatchPlan>} plan
 * @param {number} spacing
 */
async function runJit(ns, target, workers, plan, spacing) {
  if (!plan) {
    return;
  }

  let batchId = 0;
  let nextHackFinish = Date.now() + plan.weakenTime + spacing * 8;

  while (true) {
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);

    const badlyDrifted =
      money < maxMoney * 0.80 ||
      security > minSecurity + 5;

    if (badlyDrifted) {
      ns.print("Target drifted too far. Re-prepping.");
      return;
    }

    const currentBatch = batchId++;
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

      const pids = runDistributed(ns, workers, event.script, event.threads, [
        target,
        event.finishAt,
        event.duration,
        `${currentBatch}:${event.name}`
      ]);

      if (pids.length === 0) {
        ns.print(`missed ${event.name} batch=${currentBatch}; insufficient RAM`);
        failed = true;
        break;
      }
    }

    if (failed) {
      await ns.sleep(plan.weakenTime + spacing * 4);
      return;
    }

    nextHackFinish += spacing * 4;

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
      ns.print(`prep weaken threads=${weakenThreads}`);
      runDistributed(ns, workers, WEAKEN_SCRIPT, weakenThreads, [
        target,
        Date.now() + ns.getWeakenTime(target),
        ns.getWeakenTime(target),
        "prep-weaken"
      ]);

      await ns.sleep(ns.getWeakenTime(target) + 250);
      continue;
    }

    if (needsGrow) {
      const safeMoney = Math.max(1, money);
      const multiplier = maxMoney / safeMoney;
      const growThreads = Math.ceil(ns.growthAnalyze(target, multiplier));
      const growSecurity = ns.growthAnalyzeSecurity(growThreads, target);
      const weakenThreads = Math.ceil(growSecurity / ns.weakenAnalyze(1));

      ns.print(`prep grow threads=${growThreads}`);
      runDistributed(ns, workers, GROW_SCRIPT, growThreads, [
        target,
        Date.now() + ns.getGrowTime(target),
        ns.getGrowTime(target),
        "prep-grow"
      ]);

      await ns.sleep(ns.getGrowTime(target) + 250);

      ns.print(`prep post-grow weaken threads=${weakenThreads}`);
      runDistributed(ns, workers, WEAKEN_SCRIPT, weakenThreads, [
        target,
        Date.now() + ns.getWeakenTime(target),
        ns.getWeakenTime(target),
        "prep-grow-weaken"
      ]);

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

      const levelPenalty = required > level / 2 ? 0.50 : 1;
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

/** @param {number} value */
function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
