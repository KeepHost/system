#!/usr/bin/env node
// End-to-end test for an SPL pool: open it, deposit the fixed amount, withdraw
// it to a fresh token account on a proof, and check the same receipt is refused
// the second time.
//
// It creates its own mint with six decimals, the way USDC is shaped, because a
// local validator has no USDC and the real mint cannot be minted from here.
// What the pool does with a mint does not depend on which mint it is.
//
//   node scripts/e2e-token.mjs                    # local validator
//   node scripts/e2e-token.mjs --url devnet --keypair keys/deployer.json
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "../node_modules/@solana/spl-token/lib/esm/index.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { newReceipt, proveWithdraw, bytes32 } from "../client/pool.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);
const RPC_URL = args.url === "devnet" ? "https://api.devnet.solana.com" : args.url || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(
  readFileSync(new URL("../Anchor.toml", import.meta.url), "utf8").match(/keephost_pool = "([^"]+)"/)[1],
);
// Six decimals, like USDC: 10 whole tokens.
const DENOM = BigInt(args.denom || 10_000_000);

const conn = new Connection(RPC_URL, "confirmed");
const payer = args.keypair
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, "utf8"))))
  : Keypair.generate();

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const log = (...a) => console.log(...a);

async function ensureFunds(pubkey, sol) {
  if ((await conn.getBalance(pubkey)) >= sol * LAMPORTS_PER_SOL) return;
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function main() {
  log("network:", RPC_URL);
  log("program:", PROGRAM_ID.toBase58());
  await ensureFunds(payer.publicKey, 3);

  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  log("mint:", mint.toBase58(), "· six decimals, shaped like USDC");

  const depositor = await createAccount(conn, payer, mint, payer.publicKey);
  await mintTo(conn, payer, mint, depositor, payer, Number(DENOM) * 3);

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("token-pool"), payer.publicKey.toBuffer(), mint.toBuffer(), u64(DENOM)],
    PROGRAM_ID,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("token-vault-account"), pool.toBuffer()],
    PROGRAM_ID,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("token-vault"), pool.toBuffer()],
    PROGRAM_ID,
  );

  // --- open the pool ---------------------------------------------------------
  if (!(await conn.getAccountInfo(pool))) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("initialize_token_pool"), u64(DENOM)]),
    });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
    log("token pool open:", pool.toBase58(), sig);
  }

  // --- deposits --------------------------------------------------------------
  const receipts = [await newReceipt(), await newReceipt(), await newReceipt()];
  for (const [i, r] of receipts.entries()) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: depositor, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("deposit_token"), Buffer.from(bytes32(r.commitment))]),
    });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    log(`deposit ${i} · ${sig.slice(0, 20)}…`);
  }
  log("vault holds:", Number((await getAccount(conn, vault)).amount) / 1e6, "tokens");

  // --- withdrawal ------------------------------------------------------------
  const strangerOwner = Keypair.generate();
  const recipient = await createAccount(conn, payer, mint, strangerOwner.publicKey);
  const relayerAccount = await createAccount(conn, payer, mint, payer.publicKey, Keypair.generate());
  const fee = 100_000; // 0.1 token

  const { encoded, root } = await proveWithdraw({
    receipt: receipts[1],
    leaves: receipts.map((r) => r.commitment),
    index: 1,
    recipient: recipient.toBytes(),
    relayer: relayerAccount.toBytes(),
    pool: pool.toBytes(),
    fee,
    files: {
      wasm: new URL("../circuits/withdraw_js/withdraw.wasm", import.meta.url).pathname,
      zkey: new URL("../circuits/withdraw_final.zkey", import.meta.url).pathname,
    },
  });

  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), pool.toBuffer(), Buffer.from(bytes32(receipts[1].nullifierHash))],
    PROGRAM_ID,
  );

  const withdrawIx = () =>
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: relayerAccount, isSigner: false, isWritable: true },
        { pubkey: nullifierPda, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        disc("withdraw_token"),
        Buffer.from(encoded.a),
        Buffer.from(encoded.b),
        Buffer.from(encoded.c),
        Buffer.from(bytes32(root)),
        Buffer.from(bytes32(receipts[1].nullifierHash)),
        u64(fee),
      ]),
    });

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }), withdrawIx());
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  const got = Number((await getAccount(conn, recipient)).amount);
  log(`withdrawal to a fresh account · ${sig.slice(0, 20)}…`);
  log(`received ${got / 1e6} tokens (expected ${Number(DENOM - BigInt(fee)) / 1e6})`);
  if (BigInt(got) !== DENOM - BigInt(fee)) throw new Error("unexpected amount received");

  let doubleSpend = "refused";
  try {
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }), withdrawIx()),
      [payer],
      { commitment: "confirmed" },
    );
    doubleSpend = "ACCEPTED — FLAW";
  } catch {}
  log("double withdrawal:", doubleSpend);
  if (doubleSpend !== "refused") process.exit(1);

  log("");
  log("OK — an SPL pool takes a deposit, pays a proof, and refuses the second one.");
}

main().catch((e) => {
  console.error("failed:", e.message);
  if (e.logs) console.error(e.logs.slice(-6).join("\n"));
  process.exit(1);
});
