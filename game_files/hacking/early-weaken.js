/** @param {NS} ns */
export async function main(ns) {
  await ns.weaken(String(ns.args[0]));
}
