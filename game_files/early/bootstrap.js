/** @param {NS} ns */
export async function main(ns) {
  const script = "/early/worker.js";
  const target = "n00dles";

  const moneyRatio = Number(ns.args[0] || 0.75);
  const secBuffer = Number(ns.args[1] || 1);
  const homeReserveGb = Number(ns.args[2] || 2);

  const servers = [
    "home",
    "n00dles",
    "foodnstuff",
    "sigma-cosmetics",
    "joesguns",
    "hong-fang-tea",
    "harakiri-sushi",
  ];

  ns.disableLog("ALL");

  if (!ns.fileExists(script, "home")) {
    ns.tprint(`Missing ${script} on home.`);
    return;
  }

  const scriptRam = ns.getScriptRam(script, "home");

  if (scriptRam <= 0) {
    ns.tprint(`Invalid script RAM for ${script}`);
    return;
  }

  for (const server of servers) {
    if (server !== "home" && !ns.hasRootAccess(server)) {
      if (ns.getServerNumPortsRequired(server) > 0) {
        ns.print(`Skipping ${server}: requires ports.`);
        continue;
      }

      ns.nuke(server);
      ns.tprint(`Rooted ${server}`);
    }

    if (server !== "home") {
      const copied = await ns.scp(script, server, "home");

      if (!copied) {
        ns.print(`Failed to copy ${script} to ${server}`);
        continue;
      }

      ns.killall(server);
    }

    let freeRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server);

    if (server === "home") {
      freeRam -= homeReserveGb;
    }

    const threads = Math.floor(Math.max(0, freeRam) / scriptRam);

    if (threads < 1) {
      ns.print(`${server}: not enough RAM`);
      continue;
    }

    const pid = ns.exec(script, server, threads, target, moneyRatio, secBuffer);

    if (pid === 0) {
      ns.print(`${server}: failed to start ${script}`);
      continue;
    }

    ns.tprint(`${server}: ${script} x${threads} -> ${target}`);
  }
}
