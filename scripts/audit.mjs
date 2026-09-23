#!/usr/bin/env node
// L'audit des dépendances, avec ses exceptions écrites.
//
// `npm audit` seul ne sait que passer ou échouer sur un seuil de gravité, et
// baisser le seuil pour obtenir du vert revient à cacher le problème. Ici chaque
// avis toléré est nommé dans scripts/audit-exceptions.json avec la raison de le
// tolérer — et une exception qui ne correspond plus à rien fait échouer l'audit
// elle aussi : le correctif est arrivé, l'exception doit partir.
//
//   node scripts/audit.mjs
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const WORKSPACES = [".", "circuits"];
const SEP = "␟";

const { exceptions } = JSON.parse(readFileSync(new URL("./audit-exceptions.json", import.meta.url), "utf8"));

/** Les avis que npm rapporte pour un dossier, dédupliqués par paquet et titre. */
async function advisories(workspace) {
  let stdout = "";
  try {
    ({ stdout } = await run("npm", ["audit", "--json"], { cwd: `${ROOT}/${workspace}`, maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    // `npm audit` sort en échec dès qu'il trouve quelque chose : c'est le cas
    // normal ici, et le JSON est quand même sur stdout.
    stdout = e.stdout ?? "";
    if (!stdout) throw e;
  }
  const report = JSON.parse(stdout);
  const found = new Map();
  for (const entry of Object.values(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== "object") continue;
      found.set(`${via.name}${SEP}${via.title}`, {
        workspace,
        package: via.name,
        title: via.title,
        severity: via.severity,
        range: via.range,
        url: via.url,
      });
    }
  }
  return [...found.values()];
}

const key = (a) => [a.workspace, a.package, a.title].join(SEP);

const all = (await Promise.all(WORKSPACES.map(advisories))).flat();
const allowed = new Set(exceptions.map(key));

const unexpected = all.filter((a) => !allowed.has(key(a)));
const stale = exceptions.filter((e) => !all.some((a) => key(a) === key(e)));

for (const e of exceptions) {
  if (!all.some((a) => key(a) === key(e))) continue;
  console.log(`tolerated · ${e.severity} · ${e.package} (${e.workspace}) — ${e.title}`);
  console.log(`            ${Array.isArray(e.why) ? e.why.join(" ") : e.why}`);
}

if (unexpected.length) {
  console.error("");
  for (const a of unexpected) {
    console.error(`FAIL · ${a.severity} · ${a.package} (${a.workspace}) ${a.range ?? ""} — ${a.title}`);
    if (a.url) console.error(`       ${a.url}`);
  }
  console.error("");
  console.error("Fix it, or add it to scripts/audit-exceptions.json with the reason it cannot be fixed.");
  process.exit(1);
}

if (stale.length) {
  console.error("");
  for (const e of stale) {
    console.error(`FAIL · the exception for ${e.package} (${e.workspace}) matches nothing any more.`);
  }
  console.error("A fix landed. Delete the exception rather than keep a note of a problem that is gone.");
  process.exit(1);
}

console.log(`\npassed · ${all.length} advisor${all.length === 1 ? "y" : "ies"}, each one written down with a reason`);
