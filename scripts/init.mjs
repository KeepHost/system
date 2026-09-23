#!/usr/bin/env node
// Opens a pool for a given denomination. Idempotent: if the PDA already exists,
// the script does nothing and exits 0.
//
//   node scripts/init.mjs --url mainnet --keypair keys/deployer.json --denom 100000000
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);

const URLS = {
  mainnet: "https://api.mainnet-beta.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};
const RPC = URLS[args.url] || args.url || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(
  readFileSync(new URL("../Anchor.toml", import.meta.url), "utf8").match(/keephost_pool = "([^"]+)"/)[1],
);

if (!args.keypair) {
  console.error("--keypair missing: the pool creator is part of its seeds, it cannot be random");
  process.exit(2);
}
if (!args.denom) {
  console.error("--denom missing (in lamports)");
  process.exit(2);
}

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

const DENOM = BigInt(args.denom);
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, "utf8"))));

const poolPda = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), payer.publicKey.toBuffer(), u64(DENOM)],
  PROGRAM_ID,
)[0];
const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("vault"), poolPda.toBuffer()], PROGRAM_ID)[0];

// No pause key: nobody, us included, can stop this pool afterwards. The choice
// is final and readable in the opening transaction.
const PAUSE_AUTHORITY = Buffer.from([0]);

const out = { denomination: DENOM.toString(), pool: poolPda.toBase58(), vault: vaultPda.toBase58() };

if (await conn.getAccountInfo(poolPda)) {
  console.log(JSON.stringify({ ...out, created: false }));
  process.exit(0);
}

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: poolPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc("initialize"), u64(DENOM), PAUSE_AUTHORITY]),
});

const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
console.log(JSON.stringify({ ...out, created: true, signature: sig }));
