/** @param {NS} ns */
export async function main(ns) {
  const scripts = {
    hack: "scripts/hacking/early-hack.js",
    grow: "scripts/hacking/early-grow.js",
    weaken: "scripts/hacking/early-weaken.js",
  };

  // Args:
  //   0 = home RAM reserve in GB
  //   1 = money ratio before hacking
  //   2 = security buffer above minimum
  //   3 = max fraction of money to hack per deployment wave
  //   4 = verbose logging
  const homeReserveGb = parseNumberArg(ns.args[0], 4, 0, Infinity);
  const moneyTargetRatio = parseNumberArg(ns.args[1], 0.6, 0.01, 1);
  const secBuffer = parseNumberArg(ns.args[2], 3, 0, Infinity);
  const hackMoneyRatio = parseNumberArg(ns.args[3], 0.05, 0.001, 1);
  const verbose = parseBoolArg(ns.args[4], false);

  const loopDelayMs = 5_000;
  const retargetEveryLoops = 24; // 24 * 5s = 2 minutes
  const maxActionSleepMs = 60_000;

  let loop = 0;
  let currentTarget = "";
  let crackers = getCrackers(ns);

  ns.disableLog("ALL");
  ns.clearLog();

  while (true) {
    loop++;

    // Refresh crackers periodically so newly bought/created programs are noticed.
    if (loop % retargetEveryLoops === 1) {
      crackers = getCrackers(ns);
    }

    const hosts = scanAll(ns);
    const rooted = [];

    for (const host of hosts) {
      root(ns, host, crackers);

      if (ns.hasRootAccess(host)) {
        rooted.push(host);
      }
    }

    // Periodic retargeting, but do not drop a drained target if it is still
    // rooted, hackable, and growable.
    if (loop % retargetEveryLoops === 0) {
      crackers = getCrackers(ns);

      if (!isViablePrepTarget(ns, currentTarget)) {
        currentTarget = "";
      }
    }

    if (currentTarget && !isViablePrepTarget(ns, currentTarget)) {
      currentTarget = "";
    }

    if (!currentTarget) {
      currentTarget = pickTarget(ns, hosts);
    }

    if (!currentTarget) {
      ns.print("No valid target.");
      await ns.sleep(loopDelayMs);
      continue;
    }

    const minSec = ns.getServerMinSecurityLevel(currentTarget);
    const curSec = ns.getServerSecurityLevel(currentTarget);
    const maxMoney = ns.getServerMaxMoney(currentTarget);
    const curMoney = ns.getServerMoneyAvailable(currentTarget);

    let action = "";
    let script = "";
    let maxThreads = Infinity;

    if (curSec > minSec + secBuffer) {
      action = "weaken";
      script = scripts.weaken;
    } else if (curMoney < maxMoney * moneyTargetRatio) {
      action = "grow";
      script = scripts.grow;
    } else {
      action = "hack";
      script = scripts.hack;

      const hackPerThread = ns.hackAnalyze(currentTarget);

      if (hackPerThread <= 0) {
        ns.print(`Cannot calculate hack threads for ${currentTarget}.`);
        await ns.sleep(loopDelayMs);
        continue;
      }

      maxThreads = Math.max(1, Math.floor(hackMoneyRatio / hackPerThread));
    }

    const threads = await launch(
      ns,
      rooted,
      script,
      currentTarget,
      maxThreads,
      homeReserveGb,
      verbose,
    );

    const moneyPct = maxMoney > 0 ? curMoney / maxMoney : 0;

    ns.print(
      `${action} ${currentTarget}: ${threads} threads | ` +
        `money ${ns.format.percent(moneyPct, 2)} | ` +
        `sec ${curSec.toFixed(2)} / ${minSec.toFixed(2)}`,
    );

    const actionDelayMs = getActionDelay(ns, action, currentTarget);
    const sleepMs = Math.max(
      loopDelayMs,
      Math.min(actionDelayMs, maxActionSleepMs),
    );

    await ns.sleep(sleepMs);
  }
}

function scanAll(ns) {
  const seen = new Set(["home"]);
  const queue = ["home"];

  for (let i = 0; i < queue.length; i++) {
    const host = queue[i];

    for (const next of ns.scan(host)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return [...seen];
}

function getCrackers(ns) {
  const crackers = [];

  if (ns.fileExists("BruteSSH.exe", "home")) {
    crackers.push((host) => ns.brutessh(host));
  }

  if (ns.fileExists("FTPCrack.exe", "home")) {
    crackers.push((host) => ns.ftpcrack(host));
  }

  if (ns.fileExists("relaySMTP.exe", "home")) {
    crackers.push((host) => ns.relaysmtp(host));
  }

  if (ns.fileExists("HTTPWorm.exe", "home")) {
    crackers.push((host) => ns.httpworm(host));
  }

  if (ns.fileExists("SQLInject.exe", "home")) {
    crackers.push((host) => ns.sqlinject(host));
  }

  return crackers;
}

function root(ns, host, crackers) {
  if (host === "home" || ns.hasRootAccess(host)) {
    return;
  }

  if (crackers.length < ns.getServerNumPortsRequired(host)) {
    return;
  }

  for (const crack of crackers) {
    crack(host);
  }

  ns.nuke(host);
  ns.tprint(`Rooted ${host}`);
}

function isViablePrepTarget(ns, host) {
  if (!host || host === "home") {
    return false;
  }

  return (
    ns.hasRootAccess(host) &&
    ns.getServerRequiredHackingLevel(host) <= ns.getHackingLevel() &&
    ns.getServerMaxMoney(host) > 0
  );
}

function pickTarget(ns, hosts) {
  const homeMoney = ns.getServerMoneyAvailable("home");
  const hacking = ns.getHackingLevel();

  // Bootstrap phase: keep n00dles until first useful cash threshold.
  if (
    homeMoney < 250_000 &&
    ns.hasRootAccess("n00dles") &&
    ns.getServerMaxMoney("n00dles") > 0 &&
    ns.getServerRequiredHackingLevel("n00dles") <= hacking
  ) {
    return "n00dles";
  }

  let best = "";
  let bestScore = 0;

  for (const host of hosts) {
    if (host === "home" || !ns.hasRootAccess(host)) {
      continue;
    }

    const maxMoney = ns.getServerMaxMoney(host);

    if (maxMoney <= 0) {
      continue;
    }

    const requiredHack = ns.getServerRequiredHackingLevel(host);

    if (requiredHack > hacking) {
      continue;
    }

    const curMoney = ns.getServerMoneyAvailable(host);
    const minSec = ns.getServerMinSecurityLevel(host);
    const curSec = ns.getServerSecurityLevel(host);
    const hackTime = ns.getHackTime(host);
    const hackChance = ns.hackAnalyzeChance(host);
    const hackPct = ns.hackAnalyze(host);

    if (hackTime <= 0 || hackChance <= 0 || hackPct <= 0) {
      continue;
    }

    const moneyRatio = curMoney / maxMoney;
    const secDelta = Math.max(0, curSec - minSec);

    // Immediate-value score, but keep drained servers eligible by scoring them
    // as low-value prep targets instead of excluding them completely.
    let score =
      (Math.max(curMoney, maxMoney * 0.05) * hackChance * hackPct) / hackTime;

    score /= 1 + secDelta;

    if (moneyRatio < 0.5) {
      score *= 0.25;
    }

    if (requiredHack > hacking / 2) {
      score *= 0.35;
    }

    if (host === "n00dles" && homeMoney < 1_000_000) {
      score *= 3;
    }

    if (score > bestScore) {
      best = host;
      bestScore = score;
    }
  }

  return best;
}

async function launch(
  ns,
  hosts,
  script,
  target,
  maxThreads,
  homeReserveGb,
  verbose,
) {
  let totalThreads = 0;
  let remainingThreads = maxThreads;
  const scriptRam = ns.getScriptRam(script, "home");

  if (scriptRam <= 0) {
    ns.print(`Invalid script RAM for ${script}`);
    return 0;
  }

  for (const host of hosts) {
    if (remainingThreads <= 0) {
      if (verbose) {
        ns.print("Thread cap reached.");
      }

      break;
    }

    if (!(await ensureScript(ns, host, script))) {
      if (verbose) {
        ns.print(`${host}: missing ${script}`);
      }

      continue;
    }

    let availableRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);

    if (host === "home") {
      availableRam -= homeReserveGb;
    }

    availableRam = Math.max(0, availableRam);

    const possibleThreads = Math.floor(availableRam / scriptRam);

    if (possibleThreads <= 0) {
      if (verbose) {
        ns.print(`${host}: no available RAM`);
      }

      continue;
    }

    const threads =
      remainingThreads === Infinity
        ? possibleThreads
        : Math.min(possibleThreads, remainingThreads);

    if (
      !Number.isFinite(threads) ||
      threads < 1 ||
      Math.floor(threads) !== threads
    ) {
      if (verbose) {
        ns.print(`${host}: invalid thread count ${threads}`);
      }

      continue;
    }

    const pid = ns.exec(script, host, threads, target);

    if (pid === 0) {
      if (verbose) {
        ns.print(`${host}: exec failed for ${script}`);
      }

      continue;
    }

    totalThreads += threads;

    if (remainingThreads !== Infinity) {
      remainingThreads -= threads;
    }

    if (verbose) {
      ns.print(`${host}: ${script} x${threads} -> ${target}`);
    }
  }

  return totalThreads;
}

async function ensureScript(ns, host, script) {
  if (host === "home") {
    return ns.fileExists(script, "home");
  }

  if (!ns.fileExists(script, host)) {
    const copied = await ns.scp(script, host, "home");

    if (!copied) {
      return false;
    }
  }

  return ns.fileExists(script, host);
}

function getActionDelay(ns, action, target) {
  if (action === "weaken") {
    return ns.getWeakenTime(target);
  }

  if (action === "grow") {
    return ns.getGrowTime(target);
  }

  if (action === "hack") {
    return ns.getHackTime(target);
  }

  return 5_000;
}

function parseNumberArg(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function parseBoolArg(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return value === true || value === "true" || value === 1 || value === "1";
}
