#!/usr/bin/env node
// Builds an association set from the pool's deposits and a screening list, and
// prints its Merkle root.
//
// The point is that anyone can rerun this and get the same root. A set whose
// root cannot be reproduced is a claim, not a set: whoever reads it has to
// trust the publisher instead of checking them.
//
//   node scripts/build-set.mjs --pool <address> --exclude excluded.txt
//   node scripts/build-set.mjs --pool <address>            # include everything
//
// `excluded.txt` holds one commitment per line, in hex, of deposits to leave
// out — for example those traceable to a theft. Where that list comes from is
// the publisher's business, and their reputation is what it is worth.
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { buildTree, leavesFromChain } from "../client/pool.mjs";

const PROGRAM_ID = new PublicKey(
  readFileSync(new URL("../Anchor.toml", import.meta.url), "utf8").match(/keephost_pool = "([^"]+)"/)[1],
);

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);

const RPC = args.url === "devnet" ? "https://api.devnet.solana.com" : args.url || "https://api.mainnet-beta.solana.com";
const DENOM = BigInt(args.denom || 100000000);

const excluded = new Set(
  (args.exclude ? readFileSync(args.exclude, "utf8").split("\n") : [])
    .map((l) => l.trim().toLowerCase().replace(/^0x/, ""))
    .filter((l) => /^[0-9a-f]{64}$/.test(l))
    .map((l) => BigInt("0x" + l).toString()),
);

if (!args.pool) {
  console.error("--pool <address> missing: a pool address carries its creator, so it cannot be derived from a size alone");
  process.exit(2);
}
// Two ways in, and they must agree. A relayer's index is fast and survives the
// pruning public nodes do; reading the chain is slower and trusts nobody. The
// default uses the index, `--chain` forces the slow path, and a publisher who
// cares should run both and compare the root.
let all;
if (args.chain) {
  all = await leavesFromChain(new Connection(RPC, "confirmed"), new PublicKey(args.pool), PROGRAM_ID);
} else {
  const base = args.relayer || "https://keephost.fun";
  const r = await fetch(`${base.replace(/\/$/, "")}/pool/${DENOM}/leaves`);
  if (!r.ok) {
    console.error(`the relayer index answered ${r.status}; use --chain to read the chain instead`);
    process.exit(1);
  }
  const d = await r.json();
  all = d.leaves.map((l) => BigInt(l.startsWith("0x") ? l : "0x" + l));
}
const kept = all.filter((leaf) => !excluded.has(leaf.toString()));

if (kept.length === 0) {
  console.error("nothing left in the set: every deposit was excluded");
  process.exit(1);
}

const tree = await buildTree(kept);
const root = tree.root.toString(16).padStart(64, "0");

console.log(
  JSON.stringify(
    {
      denomination: DENOM.toString(),
      deposits: all.length,
      excluded: all.length - kept.length,
      included: kept.length,
      root,
      // Anyone rebuilding this set needs the same leaves in the same order:
      // the order is the order of the pool's tree, not ours to choose.
      leaves: kept.map((l) => l.toString(16).padStart(64, "0")),
    },
    null,
    2,
  ),
);
