/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const reserveRatio = Number(ns.args[0] ?? 0.25);

  const programs = [
    "BruteSSH.exe",
    "FTPCrack.exe",
    "relaySMTP.exe",
    "HTTPWorm.exe",
    "SQLInject.exe",
  ];

  const singularity = ns.singularity;

  if (!singularity) {
    return;
  }

  try {
    if (
      typeof singularity.purchaseTor === "function" &&
      !ns.hasTorRouter() &&
      ns.getServerMoneyAvailable("home") > 250_000
    ) {
      singularity.purchaseTor();
    }
  } catch {
    return;
  }

  for (const program of programs) {
    if (ns.fileExists(program, "home")) {
      continue;
    }

    if (
      typeof singularity.getDarkwebProgramCost !== "function" ||
      typeof singularity.purchaseProgram !== "function"
    ) {
      return;
    }

    let cost = 0;

    try {
      cost = singularity.getDarkwebProgramCost(program);
    } catch {
      continue;
    }

    if (cost <= 0) {
      continue;
    }

    const money = ns.getServerMoneyAvailable("home");
    const reserve = money * reserveRatio;

    if (money - cost < reserve) {
      continue;
    }

    try {
      if (singularity.purchaseProgram(program)) {
        ns.tprint(`Purchased ${program} for ${ns.format.number(cost, 3)}`);
      }
    } catch {
      continue;
    }
  }
}
