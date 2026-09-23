#!/usr/bin/env node
// End-to-end test: deposit, withdrawal with proof, and double-withdrawal refusal.
//
//   node scripts/e2e.mjs                      # local validator (already running)
//   node scripts/e2e.mjs --url devnet --keypair keys/deployer.json
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { newReceipt, proveWithdraw, bytes32, encodeReceipt, decodeReceipt, leavesFromChain } from "../client/pool.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);
const URLS = {
  mainnet: "https://api.mainnet-beta.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};
const RPC_URL = URLS[args.url] || args.url || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(
  readFileSync(new URL("../Anchor.toml", import.meta.url), "utf8").match(/keephost_pool = "([^"]+)"/)[1],
);
const DENOM = BigInt(args.denom || 0.1 * LAMPORTS_PER_SOL);

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

const conn = new Connection(RPC_URL, "confirmed");
const payer = args.keypair
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, "utf8"))))
  : Keypair.generate();

const poolPda = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), payer.publicKey.toBuffer(), u64(DENOM)],
  PROGRAM_ID,
)[0];
const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("vault"), poolPda.toBuffer()], PROGRAM_ID)[0];

const log = (...a) => console.log(...a);

async function ensureFunds(pubkey, sol) {
  const balance = await conn.getBalance(pubkey);
  if (balance >= sol * LAMPORTS_PER_SOL) return;
  // Pas de faucet ailleurs qu'en local : sur un vrai réseau, on dit ce qui
  // manque et on s'arrête plutôt que de lancer une requête qui échouera.
  if (!RPC_URL.includes("127.0.0.1") && !RPC_URL.includes("localhost")) {
    throw new Error(`fonds insuffisants : ${pubkey.toBase58()} a ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, il en faut ${sol}`);
  }
  log(`airdrop ${sol} SOL → ${pubkey.toBase58()}`);
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function initializeIfNeeded() {
  if (await conn.getAccountInfo(poolPda)) {
    log("pool already open:", poolPda.toBase58());
    return;
  }
  const data = Buffer.concat([disc("initialize"), u64(DENOM), Buffer.from([0])]); // no pause key
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  log("pool open:", poolPda.toBase58(), sig);
}

async function deposit(receipt) {
  const data = Buffer.concat([disc("deposit"), Buffer.from(bytes32(receipt.commitment))]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  return sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function withdraw({ receipt, leaves, index, recipient, fee }) {
  const relayer = payer;
  const { encoded, root } = await proveWithdraw({
    receipt,
    leaves,
    index,
    recipient: recipient.toBytes(),
    relayer: relayer.publicKey.toBytes(),
    pool: poolPda.toBytes(),
    fee,
    files: {
      wasm: new URL("../circuits/withdraw_js/withdraw.wasm", import.meta.url).pathname,
      zkey: new URL("../circuits/withdraw_final.zkey", import.meta.url).pathname,
    },
  });
  const nullifierPda = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), poolPda.toBuffer(), Buffer.from(bytes32(receipt.nullifierHash))],
    PROGRAM_ID,
  )[0];
  const data = Buffer.concat([
    disc("withdraw"),
    Buffer.from(encoded.a),
    Buffer.from(encoded.b),
    Buffer.from(encoded.c),
    Buffer.from(bytes32(root)),
    Buffer.from(bytes32(receipt.nullifierHash)),
    u64(fee),
  ]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: nullifierPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }), ix);
  return sendAndConfirmTransaction(conn, tx, [relayer], { commitment: "confirmed" });
}

async function main() {
  log("network:", RPC_URL);
  log("program:", PROGRAM_ID.toBase58());
  await ensureFunds(payer.publicKey, Number(DENOM * 3n) / LAMPORTS_PER_SOL + 0.05);
  await initializeIfNeeded();

  // Three deposits: the crowd is what hides the withdrawal.
  const receipts = [await newReceipt(), await newReceipt(), await newReceipt()];
  for (const [i, r] of receipts.entries()) {
    const sig = await deposit(r);
    log(`deposit ${i} · commitment ${bytes32(r.commitment).slice(0, 4).join("")}… · ${sig}`);
  }
  // Les feuilles se relisent sur la chaîne, jamais depuis ce qu'on croit avoir
  // déposé : le pool peut déjà en contenir d'autres, et la racine d'un arbre
  // incomplet n'existe pour personne.
  const leaves = await leavesFromChain(conn, poolPda, PROGRAM_ID);
  log(`arbre : ${leaves.length} feuilles lues sur la chaîne`);

  const mine = leaves.indexOf(receipts[1].commitment);
  if (mine < 0) throw new Error("le dépôt n'a pas été retrouvé dans l'arbre relu sur la chaîne");
  const text = encodeReceipt(receipts[1], DENOM, poolPda.toBase58(), mine);
  log("receipt:", text.slice(0, 28) + "…");
  const reread = await decodeReceipt(text);
  if (reread.commitment !== receipts[1].commitment) throw new Error("the receipt does not read back");

  const recipient = Keypair.generate().publicKey;
  const before = await conn.getBalance(recipient);
  const fee = 0;
  const sig = await withdraw({ receipt: reread, leaves, index: mine, recipient, fee });
  const after = await conn.getBalance(recipient);
  log(`withdrawal to ${recipient.toBase58()} · ${sig}`);
  log(`received ${(after - before) / LAMPORTS_PER_SOL} SOL (expected ${Number(DENOM - BigInt(fee)) / LAMPORTS_PER_SOL})`);
  if (BigInt(after - before) !== DENOM - BigInt(fee)) throw new Error("unexpected amount received");

  let doubleSpend = "refused";
  try {
    await withdraw({ receipt: reread, leaves, index: mine, recipient, fee });
    doubleSpend = "ACCEPTED — FLAW";
  } catch {}
  log("double withdrawal:", doubleSpend);
  if (doubleSpend !== "refused") process.exit(1);

  log("\nOK — deposit, withdrawal and double-withdrawal prevention work.");
}

main().catch((e) => {
  console.error("failed:", e.message);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
