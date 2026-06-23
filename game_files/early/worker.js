/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args[0] || "n00dles";

  const moneyRatio = Number(ns.args[1] || 0.75);
  const secBuffer = Number(ns.args[2] || 1);

  ns.disableLog("ALL");

  while (true) {
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const sec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);

    if (sec > minSec + secBuffer) {
      await ns.weaken(target);
      continue;
    }

    if (money < maxMoney * moneyRatio) {
      await ns.grow(target);
      continue;
    }

    await ns.hack(target);
  }
}
