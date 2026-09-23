#!/usr/bin/env node
// Offline proof test: build receipts, build the tree, prove a withdrawal and
// verify it — no chain, no validator, no Solana toolchain.
//
// What it proves: the circuit, the proving key and the client library agree,
// an honest proof verifies, and a proof made for one recipient does not verify
// for another. What it does not prove: that the on-chain program accepts it —
// that is scripts/e2e.mjs, which needs a validator.
//
//   node scripts/test-proof.mjs
import { groth16 } from "../circuits/node_modules/snarkjs/build/main.cjs";
import { readFileSync } from "node:fs";
import { newReceipt, buildTree, splitPubkey, encodeReceipt, decodeReceipt } from "../client/pool.mjs";

const files = {
  wasm: new URL("../circuits/withdraw_js/withdraw.wasm", import.meta.url).pathname,
  zkey: new URL("../circuits/withdraw_final.zkey", import.meta.url).pathname,
};
const vkey = JSON.parse(readFileSync(new URL("../circuits/verification_key.json", import.meta.url), "utf8"));

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

const random32 = () => Uint8Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));

const receipts = [await newReceipt(), await newReceipt(), await newReceipt()];
const leaves = receipts.map((r) => r.commitment);
const tree = await buildTree(leaves);

// The receipt has to survive a round trip through the text the user saves.
const text = encodeReceipt(receipts[1], 100000000n, "", 1);
const reread = await decodeReceipt(text);
if (reread.commitment !== receipts[1].commitment) fail("the receipt does not read back");

const recipient = splitPubkey(random32());
const relayer = splitPubkey(random32());
const pool = splitPubkey(random32());
const { elements, indices } = tree.path(1);

const input = {
  root: tree.root.toString(),
  nullifierHash: receipts[1].nullifierHash.toString(),
  recipientHi: recipient.hi.toString(),
  recipientLo: recipient.lo.toString(),
  relayerHi: relayer.hi.toString(),
  relayerLo: relayer.lo.toString(),
  fee: "0",
  poolHi: pool.hi.toString(),
  poolLo: pool.lo.toString(),
  nullifier: receipts[1].nullifier.toString(),
  secret: receipts[1].secret.toString(),
  pathElements: elements.map((e) => e.toString()),
  pathIndices: indices.map((i) => i.toString()),
};

const { proof, publicSignals } = await groth16.fullProve(input, files.wasm, files.zkey);
if (!(await groth16.verify(vkey, publicSignals, proof))) fail("an honest proof does not verify");
console.log("ok · an honest withdrawal proof verifies");

// The recipient is sealed in the proof: changing it must break verification,
// or a relayer could redirect the payment.
const moved = [...publicSignals];
moved[2] = (BigInt(moved[2]) + 1n).toString();
if (await groth16.verify(vkey, moved, proof)) fail("the proof still verifies with another recipient");
console.log("ok · the proof is refused once the recipient changes");

// A wrong root must not verify either: otherwise a deposit that is not in the
// tree could be spent.
const wrongRoot = [...publicSignals];
wrongRoot[0] = (BigInt(wrongRoot[0]) + 1n).toString();
if (await groth16.verify(vkey, wrongRoot, proof)) fail("the proof still verifies with another root");
console.log("ok · the proof is refused once the root changes");

console.log("passed");
process.exit(0);
