/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const target = String(ns.args[0]);
  const finishAt = Number(ns.args[1]);
  const duration = Number(ns.args[2]);
  const batchId = String(ns.args[3] ?? "unknown");

  const additionalMsec = Math.max(0, finishAt - Date.now() - duration);

  try {
    await ns.grow(target, { additionalMsec });
  } catch (error) {
    ns.print(`grow failed batch=${batchId} target=${target}: ${String(error)}`);
  }
}
