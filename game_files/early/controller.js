/** @param {NS} ns */
export async function main(ns) {
  const scripts = {
    hack: "/hack.js",
    grow: "/grow.js",
    weaken: "/weaken.js",
  };

  const workerScripts = Object.values(scripts);

  const homeReserveGb = numberArg(ns.args[0], 3);
  const moneyFloor = numberArg(ns.args[1], 0.95);
  const secBuffer = numberArg(ns.args[2], 0.05);
  const hackFraction = numberArg(ns.args[3], 0.05);

  const loopDelayMs = 1000;
  const settleMs = 250;

  ns.disableLog("ALL");
  ns.clearLog();

  while (true) {
    const hosts = scanAll(ns);

    for (const host of hosts) {
      tryRoot(ns, host);
    }

    const rooted = [];

    for (const host of hosts) {
      if (!ns.hasRootAccess(host)) {
        continue;
      }

      if (!(await ensureScripts(ns, host, workerScripts))) {
        continue;
      }

      if (usableRam(ns, host, homeReserveGb) <= 0) {
        continue;
      }

      rooted.push(host);
    }

    const target = pickTarget(ns, hosts);

    if (!target) {
      ns.print("No target.");
      await ns.sleep(loopDelayMs);
      continue;
    }

    const maxMoney = ns.getServerMaxMoney(target);
    const curMoney = ns.getServerMoneyAvailable(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    const curSec = ns.getServerSecurityLevel(target);

    let action;
    let threadsNeeded;
    let waitMs;

    if (curSec > minSec + secBuffer) {
      action = "weaken";
      threadsNeeded = Math.ceil((curSec - minSec) / ns.weakenAnalyze(1));
      waitMs = ns.getWeakenTime(target);
    } else if (curMoney < maxMoney * moneyFloor) {
      action = "grow";

      const growFactor = Math.max(1.01, maxMoney / Math.max(1, curMoney));
      threadsNeeded = Math.ceil(ns.growthAnalyze(target, growFactor));

      waitMs = ns.getGrowTime(target);
    } else {
      action = "hack";

      const hackPerThread = ns.hackAnalyze(target);

      if (hackPerThread <= 0) {
        ns.print(`Cannot calculate hack threads for ${target}.`);
        await ns.sleep(loopDelayMs);
        continue;
      }

      threadsNeeded = Math.max(1, Math.floor(hackFraction / hackPerThread));
      waitMs = ns.getHackTime(target);
    }

    const launched = launch(
      ns,
      rooted,
      scripts[action],
      target,
      threadsNeeded,
      homeReserveGb,
    );

    const moneyPct = maxMoney > 0 ? curMoney / maxMoney : 0;

    ns.print(
      `${action} ${target}: ${launched}/${threadsNeeded} threads | ` +
        `money ${ns.format.percent(moneyPct, 2)} | ` +
        `sec ${curSec.toFixed(2)} / ${minSec.toFixed(2)}`,
    );

    if (launched === 0) {
      await ns.sleep(loopDelayMs);
      continue;
    }

    await ns.sleep(waitMs + settleMs);
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

function tryRoot(ns, host) {
  if (host === "home" || ns.hasRootAccess(host)) {
    return;
  }

  const crackers = [];

  if (ns.fileExists("BruteSSH.exe", "home")) {
    crackers.push((target) => ns.brutessh(target));
  }

  if (ns.fileExists("FTPCrack.exe", "home")) {
    crackers.push((target) => ns.ftpcrack(target));
  }

  if (ns.fileExists("relaySMTP.exe", "home")) {
    crackers.push((target) => ns.relaysmtp(target));
  }

  if (ns.fileExists("HTTPWorm.exe", "home")) {
    crackers.push((target) => ns.httpworm(target));
  }

  if (ns.fileExists("SQLInject.exe", "home")) {
    crackers.push((target) => ns.sqlinject(target));
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

function pickTarget(ns, hosts) {
  const hacking = ns.getHackingLevel();

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

    const required = ns.getServerRequiredHackingLevel(host);

    if (required > hacking) {
      continue;
    }

    const minSec = ns.getServerMinSecurityLevel(host);
    const curSec = ns.getServerSecurityLevel(host);
    const hackTime = ns.getHackTime(host);
    const chance = ns.hackAnalyzeChance(host);
    const hackPct = ns.hackAnalyze(host);

    if (hackTime <= 0 || chance <= 0 || hackPct <= 0) {
      continue;
    }

    let score = (maxMoney * chance * hackPct) / hackTime;

    score /= Math.max(1, minSec);
    score /= 1 + Math.max(0, curSec - minSec);

    if (required > hacking / 2) {
      score *= 0.35;
    }

    if (score > bestScore) {
      best = host;
      bestScore = score;
    }
  }

  return best;
}

function launch(ns, hosts, script, target, wantedThreads, homeReserveGb) {
  let remaining = wantedThreads;
  let launched = 0;

  const scriptRam = ns.getScriptRam(script, "home");

  if (scriptRam <= 0) {
    ns.print(`Invalid script RAM: ${script}`);
    return 0;
  }

  for (const host of hosts) {
    if (remaining <= 0) {
      break;
    }

    const available = usableRam(ns, host, homeReserveGb);
    const possible = Math.floor(available / scriptRam);
    const threads = Math.min(possible, remaining);

    if (threads < 1) {
      continue;
    }

    const pid = ns.exec(script, host, threads, target);

    if (pid === 0) {
      continue;
    }

    launched += threads;
    remaining -= threads;
  }

  return launched;
}

function usableRam(ns, host, homeReserveGb) {
  let ram = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);

  if (host === "home") {
    ram -= homeReserveGb;
  }

  return Math.max(0, ram);
}

async function ensureScripts(ns, host, scripts) {
  if (host === "home") {
    return scripts.every((script) => ns.fileExists(script, "home"));
  }

  const missing = scripts.filter((script) => !ns.fileExists(script, host));

  if (missing.length === 0) {
    return true;
  }

  return await ns.scp(missing, host, "home");
}

function numberArg(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}
