/** @param {NS} ns */
export async function main(ns) {
  await ns.grow(String(ns.args[0]));
}
