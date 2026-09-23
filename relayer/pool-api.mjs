#!/usr/bin/env node
// KeepHost pool service: deposit index + withdrawal relayer.
//
//   RELAYER_KEYPAIR=… CLUSTER=devnet PORT=8134 node pool-api.mjs
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const PORT = Number(process.env.PORT || 8134);
const CLUSTER = process.env.CLUSTER || "devnet";
const URL_RPC = process.env.SOLANA_RPC || (CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || readFileSync(new URL("../Anchor.toml", import.meta.url), "utf8").match(/keephost_pool = "([^"]+)"/)[1]);
const KEYPAIR_FILE = process.env.RELAYER_KEYPAIR || "";
// Rent of a nullifier account (72 bytes): below that, the relayer loses money
// on every withdrawal and ends up empty.
const NULLIFIER_RENT = 1_392_000n;
const FEE = BigInt(process.env.RELAYER_FEE || NULLIFIER_RENT + 10_000n);

const conn = new Connection(URL_RPC, "confirmed");
const relayer = KEYPAIR_FILE ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_FILE, "utf8")))) : null;

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const eventDisc = (name) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const DEPOSITED = eventDisc("Deposited");
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
// Le créateur entre dans les seeds du pool : sans lui, l'adresse calculée ici
// n'est celle de personne. C'est ce qui rend les pools officiels identifiables —
// n'importe qui peut ouvrir un pool de la même taille, seul celui de ce créateur
// est le nôtre, et il est écrit sur la page d'accueil.
const CREATOR = new PublicKey(process.env.POOL_CREATOR || "8dsM4x5xZKUGDGgCJCX4hLro5hnbnspW92jH14N96otD");
const poolPda = (denom) =>
  PublicKey.findProgramAddressSync([Buffer.from("pool"), CREATOR.toBuffer(), u64(denom)], PROGRAM_ID)[0];
const vaultPda = (pool) => PublicKey.findProgramAddressSync([Buffer.from("vault"), pool.toBuffer()], PROGRAM_ID)[0];
const nullifierPda = (pool, hash) => PublicKey.findProgramAddressSync([Buffer.from("nullifier"), pool.toBuffer(), hash], PROGRAM_ID)[0];

const STORE = process.env.POOL_INDEX || "/opt/keephost/data/pool-index.json";
const index = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(STORE, "utf8")))) index.set(k, { ...v, at: 0 });
} catch {
  /* no index file yet */
}
function persist() {
  // Public RPCs prune history: without this copy, a late restart could no
  // longer rebuild the tree and the receipts would become unusable.
  try {
    const out = {};
    for (const [k, v] of index) out[k] = { leaves: v.leaves, until: v.until };
    writeFileSync(STORE + ".tmp", JSON.stringify(out));
    renameSync(STORE + ".tmp", STORE);
  } catch (e) {
    console.error("[pool-api] index not saved:", e.message);
  }
}

async function refresh(denom) {
  const key = String(denom);
  const state = index.get(key) || { leaves: [], until: null, at: 0 };
  if (Date.now() - state.at < 4000) return state;
  const pool = poolPda(denom);
  const sigs = [];
  let before;
  for (;;) {
    const page = await conn.getSignaturesForAddress(pool, { before, until: state.until || undefined, limit: 1000 });
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  sigs.reverse();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    // Only events written between our program's invoke and its end count: the
    // Anchor discriminator is public and anyone could imitate it to poison the index.
    let depth = 0;
    for (const line of tx?.meta?.logMessages ?? []) {
      if (line.startsWith(`Program ${PROGRAM_ID.toBase58()} invoke`)) depth++;
      else if (line.startsWith(`Program ${PROGRAM_ID.toBase58()} success`) || line.startsWith(`Program ${PROGRAM_ID.toBase58()} failed`)) depth = Math.max(0, depth - 1);
      else if (depth > 0 && line.startsWith("Program data: ")) {
        const raw = Buffer.from(line.slice("Program data: ".length), "base64");
        if (raw.length < 76 || !raw.subarray(0, 8).equals(DEPOSITED)) continue;
        const commitment = raw.subarray(40, 72).toString("hex");
        const leafIndex = raw.readUInt32LE(72);
        if (leafIndex >= 1 << 20) continue;
        state.leaves[leafIndex] = commitment;
      }
    }
  }
  if (sigs.length) state.until = sigs[sigs.length - 1].signature;
  state.at = Date.now();
  index.set(key, state);
  if (sigs.length) persist();
  return state;
}

function send(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(buf);
}

function readJson(req, max = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too big"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad json"));
      }
    });
  });
}

const bytes = (hex, len) => {
  if (typeof hex !== "string" || !new RegExp(`^[0-9a-fA-F]{${len * 2}}$`).test(hex)) throw new Error("bad hex");
  return Buffer.from(hex, "hex");
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return send(res, 204, {});

    if (req.method === "GET" && url.pathname === "/pool/state") {
      const pools = [];
      for (const denom of (process.env.DENOMS || "100000000,1000000000,10000000000").split(",")) {
        const pool = poolPda(denom);
        const info = await conn.getAccountInfo(pool);
        const vault = await conn.getBalance(vaultPda(pool));
        pools.push({ denomination: denom, address: pool.toBase58(), open: !!info, vaultLamports: vault });
      }
      return send(res, 200, { cluster: CLUSTER, programId: PROGRAM_ID.toBase58(), relayer: relayer?.publicKey.toBase58() ?? null, fee: FEE.toString(), pools });
    }

    const leavesMatch = url.pathname.match(/^\/pool\/(\d+)\/leaves$/);
    if (req.method === "GET" && leavesMatch) {
      const state = await refresh(leavesMatch[1]);
      return send(res, 200, { leaves: state.leaves.map((l) => l || null) });
    }

    const withdrawMatch = url.pathname.match(/^\/pool\/(\d+)\/withdraw$/);
    if (req.method === "POST" && withdrawMatch) {
      if (!relayer) return send(res, 503, { error: "This relayer has no key configured." });
      const body = await readJson(req);
      // La commission est scellée dans la preuve : si le client en a utilisé une
      // autre, la preuve ne vérifiera pas et c'est le relayer qui aurait payé
      // les frais de la transaction refusée. On le dit avant, pas après.
      if (body.fee !== undefined && BigInt(body.fee) !== FEE) {
        return send(res, 409, { error: "fee mismatch", expected: FEE.toString() });
      }
      const denom = withdrawMatch[1];
      const pool = poolPda(denom);
      const recipient = new PublicKey(body.recipient);
      const nullifierHash = bytes(body.nullifierHash, 32);
      const data = Buffer.concat([
        disc("withdraw"),
        bytes(body.proofA, 64),
        bytes(body.proofB, 128),
        bytes(body.proofC, 64),
        bytes(body.root, 32),
        nullifierHash,
        u64(FEE),
      ]);
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
          { pubkey: pool, isSigner: false, isWritable: true },
          { pubkey: vaultPda(pool), isSigner: false, isWritable: true },
          { pubkey: recipient, isSigner: false, isWritable: true },
          { pubkey: nullifierPda(pool, nullifierHash), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }), ix);
      // Simulation d'abord : une preuve invalide coûterait les frais au relayer,
      // et n'importe qui peut en envoyer. Ici, elle ne coûte rien à personne.
      tx.feePayer = relayer.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) {
        return send(res, 422, {
          error: "the program refused this withdrawal",
          logs: (sim.value.logs ?? []).filter((l) => l.includes("Error") || l.includes("AnchorError")).slice(0, 3),
        });
      }
      const signature = await sendAndConfirmTransaction(conn, tx, [relayer], { commitment: "confirmed" });
      return send(res, 200, { ok: true, signature, fee: FEE.toString() });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: String(e.message || e).slice(0, 200) });
  }
}).listen(PORT, "127.0.0.1", () =>
  console.log(`[pool-api] 127.0.0.1:${PORT} · ${CLUSTER} · program ${PROGRAM_ID.toBase58()} · relayer ${relayer?.publicKey.toBase58() ?? "none"}`),
);
