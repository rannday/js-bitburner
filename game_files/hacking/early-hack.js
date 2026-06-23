/** @param {NS} ns */
export async function main(ns) {
  await ns.hack(String(ns.args[0]));
}
