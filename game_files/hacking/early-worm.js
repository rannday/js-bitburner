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
  //   2 = security buffer above min
  //   3 = max fraction of server money to hack per cycle
  const homeReserveGb = Number(ns.args[0] ?? 4);
  const moneyTargetRatio = Number(ns.args[1] ?? 0.6);
  const secBuffer = Number(ns.args[2] ?? 3);
  const hackMoneyRatio = Number(ns.args[3] ?? 0.05);

  const loopDelayMs = 5_000;
  const actionBufferMs = 250;

  ns.disableLog("ALL");
  ns.clearLog();

  while (true) {
    const hosts = scanAll(ns);
    const rooted = [];

    for (const host of hosts) {
      root(ns, host);

      if (ns.hasRootAccess(host)) {
        rooted.push(host);
      }
    }

    const target = pickTarget(ns, hosts);

    if (!target) {
      ns.print("No valid target.");
      await ns.sleep(loopDelayMs);
      continue;
    }

    const minSec = ns.getServerMinSecurityLevel(target);
    const curSec = ns.getServerSecurityLevel(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const curMoney = ns.getServerMoneyAvailable(target);

    let action = "";
    let script = "";
    let maxThreads = Infinity;
    let waitMs = loopDelayMs;

    if (curSec > minSec + secBuffer) {
      action = "weaken";
      script = scripts.weaken;
      waitMs = ns.getWeakenTime(target) + actionBufferMs;
    } else if (curMoney < maxMoney * moneyTargetRatio) {
      action = "grow";
      script = scripts.grow;
      waitMs = ns.getGrowTime(target) + actionBufferMs;
    } else {
      action = "hack";
      script = scripts.hack;

      const hackPerThread = ns.hackAnalyze(target);

      if (hackPerThread <= 0) {
        ns.print(`Cannot calculate hack threads for ${target}.`);
        await ns.sleep(loopDelayMs);
        continue;
      }

      maxThreads = Math.max(1, Math.floor(hackMoneyRatio / hackPerThread));
      waitMs = ns.getHackTime(target) + actionBufferMs;
    }

    const threads = await launch(
      ns,
      rooted,
      script,
      target,
      maxThreads,
      homeReserveGb,
    );

    const moneyPct = maxMoney > 0 ? curMoney / maxMoney : 0;

    ns.print(
      `${action} ${target}: ${threads} threads | ` +
        `money ${ns.format.percent(moneyPct, 2)} | ` +
        `sec ${curSec.toFixed(2)} / ${minSec.toFixed(2)}`,
    );

    if (threads <= 0) {
      await ns.sleep(loopDelayMs);
      continue;
    }

    await ns.sleep(waitMs);
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

function root(ns, host) {
  if (host === "home" || ns.hasRootAccess(host)) {
    return;
  }

  let ports = 0;

  if (ns.fileExists("BruteSSH.exe", "home")) {
    ns.brutessh(host);
    ports++;
  }

  if (ns.fileExists("FTPCrack.exe", "home")) {
    ns.ftpcrack(host);
    ports++;
  }

  if (ns.fileExists("relaySMTP.exe", "home")) {
    ns.relaysmtp(host);
    ports++;
  }

  if (ns.fileExists("HTTPWorm.exe", "home")) {
    ns.httpworm(host);
    ports++;
  }

  if (ns.fileExists("SQLInject.exe", "home")) {
    ns.sqlinject(host);
    ports++;
  }

  if (ports >= ns.getServerNumPortsRequired(host)) {
    ns.nuke(host);
    ns.tprint(`Rooted ${host}`);
  }
}

function pickTarget(ns, hosts) {
  const homeMoney = ns.getServerMoneyAvailable("home");
  const hacking = ns.getHackingLevel();

  // Bootstrap phase:
  // Force n00dles until the first useful cash threshold.
  // This avoids spending the first several minutes prepping foodnstuff/sigma.
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
    if (!ns.hasRootAccess(host)) {
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

    if (curMoney <= 0 || hackTime <= 0 || hackChance <= 0 || hackPct <= 0) {
      continue;
    }

    const moneyRatio = curMoney / maxMoney;
    const secDelta = Math.max(0, curSec - minSec);

    // Immediate-value scoring:
    // Prefer servers that can pay now, are quick to hack, have good chance,
    // and are not badly over minimum security.
    let score = (curMoney * hackChance * hackPct) / hackTime;

    // Penalize security drift.
    score /= 1 + secDelta;

    // Penalize unprepped targets, but do not fully exclude them.
    if (moneyRatio < 0.5) {
      score *= 0.25;
    }

    // Penalize targets close to your current hacking limit.
    if (requiredHack > hacking / 2) {
      score *= 0.35;
    }

    // Keep n00dles sticky during early cash phase.
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

async function launch(ns, hosts, script, target, maxThreads, homeReserveGb) {
  let totalThreads = 0;
  let remainingThreads = maxThreads;

  for (const host of hosts) {
    if (remainingThreads <= 0) {
      break;
    }

    if (!(await ensureScript(ns, host, script))) {
      continue;
    }

    const scriptRam = ns.getScriptRam(script, host);

    if (scriptRam <= 0) {
      continue;
    }

    let availableRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);

    if (host === "home") {
      availableRam -= homeReserveGb;
    }

    const possibleThreads = Math.floor(availableRam / scriptRam);

    if (possibleThreads <= 0) {
      continue;
    }

    const threads =
      remainingThreads === Infinity
        ? possibleThreads
        : Math.min(possibleThreads, remainingThreads);

    const pid = ns.exec(script, host, threads, target);

    if (pid === 0) {
      continue;
    }

    totalThreads += threads;

    if (remainingThreads !== Infinity) {
      remainingThreads -= threads;
    }
  }

  return totalThreads;
}

async function ensureScript(ns, host, script) {
  if (host === "home") {
    return ns.fileExists(script, "home");
  }

  if (!ns.fileExists(script, host)) {
    await ns.scp(script, host);
  }

  return ns.fileExists(script, host);
}
