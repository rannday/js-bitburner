/** @param {NS} ns */
export async function main(ns) {
  const reserve = Number(ns.args[0] ?? 100_000);
  const maxPayoffTime = Number(ns.args[1] ?? 600);

  ns.disableLog("ALL");
  ns.clearLog();

  const didUpgrade = upgradeBest(ns, reserve, maxPayoffTime);

  if (!didUpgrade) {
    ns.tprint(
      `No Hacknet upgrade under ${ns.format.number(maxPayoffTime, 2)}s payoff. ` +
        `Money: ${ns.format.number(ns.getServerMoneyAvailable("home"), 3)}`,
    );
  }
}

function upgradeBest(ns, reserve, maxPayoffTime) {
  const money = ns.getServerMoneyAvailable("home");
  const budget = money - reserve;

  if (budget <= 0) {
    return false;
  }

  let best = {
    type: "",
    index: -1,
    cost: Infinity,
    gain: 0,
    payoffTime: Infinity,
  };

  const nodeCost = ns.hacknet.getPurchaseNodeCost();

  if (Number.isFinite(nodeCost) && nodeCost > 0 && nodeCost <= budget) {
    const gain = estimateNewNodeGain(ns);
    const payoffTime = nodeCost / gain;

    if (gain > 0 && payoffTime < best.payoffTime) {
      best = {
        type: "node",
        index: -1,
        cost: nodeCost,
        gain,
        payoffTime,
      };
    }
  }

  for (let i = 0; i < ns.hacknet.numNodes(); i++) {
    const stats = ns.hacknet.getNodeStats(i);

    best = maybeUpgrade(
      best,
      ns,
      i,
      "level",
      ns.hacknet.getLevelUpgradeCost(i, 1),
      budget,
      stats,
    );
    best = maybeUpgrade(
      best,
      ns,
      i,
      "ram",
      ns.hacknet.getRamUpgradeCost(i, 1),
      budget,
      stats,
    );
    best = maybeUpgrade(
      best,
      ns,
      i,
      "core",
      ns.hacknet.getCoreUpgradeCost(i, 1),
      budget,
      stats,
    );
  }

  if (
    best.type === "" ||
    best.cost > budget ||
    best.payoffTime > maxPayoffTime
  ) {
    return false;
  }

  if (best.type === "node") {
    const index = ns.hacknet.purchaseNode();

    if (index !== -1) {
      ns.tprint(
        `Purchased Hacknet node ${index} | ` +
          `cost ${ns.format.number(best.cost, 3)} | ` +
          `gain ${ns.format.number(best.gain, 3)}/s | ` +
          `payoff ${ns.format.number(best.payoffTime, 2)}s`,
      );
      return true;
    }

    return false;
  }

  let ok = false;

  if (best.type === "level") {
    ok = ns.hacknet.upgradeLevel(best.index, 1);
  } else if (best.type === "ram") {
    ok = ns.hacknet.upgradeRam(best.index, 1);
  } else if (best.type === "core") {
    ok = ns.hacknet.upgradeCore(best.index, 1);
  }

  if (!ok) {
    return false;
  }

  ns.tprint(
    `Upgraded Hacknet node ${best.index} ${best.type} | ` +
      `cost ${ns.format.number(best.cost, 3)} | ` +
      `gain ${ns.format.number(best.gain, 3)}/s | ` +
      `payoff ${ns.format.number(best.payoffTime, 2)}s`,
  );

  return true;
}

function maybeUpgrade(best, ns, index, type, cost, budget, stats) {
  if (!Number.isFinite(cost) || cost <= 0 || cost > budget) {
    return best;
  }

  const gain = estimateUpgradeGain(ns, stats, type);

  if (gain <= 0) {
    return best;
  }

  const payoffTime = cost / gain;

  if (payoffTime < best.payoffTime) {
    return {
      type,
      index,
      cost,
      gain,
      payoffTime,
    };
  }

  return best;
}

function estimateNewNodeGain(ns) {
  return hacknetProduction(ns, 1, 1, 1);
}

function estimateUpgradeGain(ns, stats, type) {
  const current = hacknetProduction(ns, stats.level, stats.ram, stats.cores);

  let next = current;

  if (type === "level") {
    next = hacknetProduction(ns, stats.level + 1, stats.ram, stats.cores);
  } else if (type === "ram") {
    next = hacknetProduction(ns, stats.level, stats.ram * 2, stats.cores);
  } else if (type === "core") {
    next = hacknetProduction(ns, stats.level, stats.ram, stats.cores + 1);
  }

  return next - current;
}

function hacknetProduction(ns, level, ram, cores) {
  const mults = ns.getHacknetMultipliers();

  return (
    level *
    1.5 *
    Math.pow(1.035, ram - 1) *
    ((cores + 5) / 6) *
    mults.production
  );
}
