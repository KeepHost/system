// KeepHost pool client library: receipts, Merkle tree, withdrawal proofs.
// Runs in the user's browser — the receipt never leaves their machine.
import { buildPoseidon } from "../circuits/node_modules/circomlibjs/src/poseidon_wasm.js";
import { groth16 } from "../circuits/node_modules/snarkjs/build/main.cjs";
import { readFileSync } from "node:fs";

/** Order of the BN254 scalar field (circuit values). */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** Order of the BN254 base field (point coordinates). */
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const LEVELS = 20;

const ZEROS = JSON.parse(readFileSync(new URL("./zeros.json", import.meta.url), "utf8")).zeros.map((h) => BigInt("0x" + h));

let poseidonPromise;
/** Returns a Poseidon hash function over field elements. */
export async function poseidonReady() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  const p = await poseidonPromise;
  return (inputs) => p.F.toObject(p(inputs));
}

const hex32 = (v) => v.toString(16).padStart(64, "0");
/** Returns a field element as 32 big-endian bytes. */
export const bytes32 = (v) => Uint8Array.from(hex32(v).match(/../g).map((b) => parseInt(b, 16)));

function randomField() {
  // Rejection sampling rather than a fold modulo p: folding would make small
  // values ~25 % more likely.
  for (;;) {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const v = BigInt("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
    if (v < FIELD) return v;
  }
}

/** Returns a new receipt: two secrets, their commitment, and the nullifier hash. */
export async function newReceipt() {
  const hash = await poseidonReady();
  const nullifier = randomField();
  const secret = randomField();
  return {
    nullifier,
    secret,
    commitment: hash([nullifier, secret]),
    nullifierHash: hash([nullifier]),
  };
}

/** Returns the receipt text the user saves; losing it means losing the funds. */
export function encodeReceipt({ nullifier, secret }, denomination, pool = "", index = "") {
  // The pool and leaf index are carried along: without them, rebuilding the
  // Merkle path needs the full chain history, which public RPCs prune.
  return `keephost-v1-${denomination}-${pool || "-"}-${index === "" ? "-" : index}-${hex32(nullifier)}${hex32(secret)}`;
}

/** Returns the parsed receipt, with its commitment and nullifier hash. */
export async function decodeReceipt(text) {
  const m = String(text).trim().match(/^keephost-v1-(\d+)-([1-9A-HJ-NP-Za-km-z]{32,44}|-)-(\d+|-)-([0-9a-fA-F]{64})([0-9a-fA-F]{64})$/);
  if (!m) throw new Error("Receipt not recognised");
  const hash = await poseidonReady();
  const nullifier = BigInt("0x" + m[4]);
  const secret = BigInt("0x" + m[5]);
  return {
    denomination: BigInt(m[1]),
    pool: m[2] === "-" ? null : m[2],
    index: m[3] === "-" ? null : Number(m[3]),
    nullifier,
    secret,
    commitment: hash([nullifier, secret]),
    nullifierHash: hash([nullifier]),
  };
}

/** Returns the tree root and a path() accessor, built from the on-chain commitments. */
export async function buildTree(leaves) {
  const hash = await poseidonReady();
  const layers = [leaves.slice()];
  for (let level = 0; level < LEVELS; level++) {
    const prev = layers[level];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = i + 1 < prev.length ? prev[i + 1] : ZEROS[level];
      next.push(hash([left, right]));
    }
    layers.push(next);
  }
  const root = layers[LEVELS][0] ?? ZEROS[LEVELS];
  return {
    root,
    path(index) {
      const elements = [];
      const indices = [];
      let i = index;
      for (let level = 0; level < LEVELS; level++) {
        const sibling = i % 2 === 0 ? layers[level][i + 1] ?? ZEROS[level] : layers[level][i - 1];
        elements.push(sibling);
        indices.push(i % 2);
        i = Math.floor(i / 2);
      }
      return { elements, indices };
    },
  };
}

/** Returns a public key as two 16-byte halves, the same split the program uses. */
export function splitPubkey(bytes) {
  // Reducing the 32 bytes modulo p would give ~5 preimages per address, letting
  // a relayer redirect a withdrawal to a twin address it holds no key for.
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hi: BigInt("0x" + hex.slice(0, 32)), lo: BigInt("0x" + hex.slice(32)) };
}

/** Returns the withdrawal proof, its public signals and root. `files` = { wasm, zkey }. */
export async function proveWithdraw({ receipt, leaves, index, recipient, relayer, pool, fee, files }) {
  const tree = await buildTree(leaves);
  const { elements, indices } = tree.path(index);
  const r = splitPubkey(recipient);
  const l = splitPubkey(relayer);
  const p = splitPubkey(pool);
  const input = {
    root: tree.root.toString(),
    nullifierHash: receipt.nullifierHash.toString(),
    recipientHi: r.hi.toString(),
    recipientLo: r.lo.toString(),
    relayerHi: l.hi.toString(),
    relayerLo: l.lo.toString(),
    fee: BigInt(fee).toString(),
    poolHi: p.hi.toString(),
    poolLo: p.lo.toString(),
    nullifier: receipt.nullifier.toString(),
    secret: receipt.secret.toString(),
    pathElements: elements.map((e) => e.toString()),
    pathIndices: indices.map((i) => i.toString()),
  };
  const { proof, publicSignals } = await groth16.fullProve(input, files.wasm, files.zkey);
  return { proof, publicSignals, root: tree.root, encoded: encodeProof(proof) };
}

/** Returns the proof points as the Solana syscalls expect them. */
export function encodeProof(proof) {
  // A is negated and the G2 components are swapped (c1 before c0): that is what
  // groth16-solana expects, since it performs a single pairing.
  const g1 = (p) => concat(bytes32(BigInt(p[0])), bytes32(BigInt(p[1])));
  const negY = (y) => (BASE - (BigInt(y) % BASE)) % BASE;
  return {
    a: concat(bytes32(BigInt(proof.pi_a[0])), bytes32(negY(proof.pi_a[1]))),
    b: concat(
      bytes32(BigInt(proof.pi_b[0][1])),
      bytes32(BigInt(proof.pi_b[0][0])),
      bytes32(BigInt(proof.pi_b[1][1])),
      bytes32(BigInt(proof.pi_b[1][0])),
    ),
    c: g1(proof.pi_c),
  };
}

function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/**
 * The leaves of a pool's tree, read back from the chain.
 *
 * A client that only knows its own deposits builds a tree the program has never
 * seen: its root is not in the pool's root history and the withdrawal is
 * rejected with UnknownRoot. That is not theory — it happened on mainnet on
 * 23 September 2026, on a pool that already held three deposits from an earlier
 * run. Anything that builds a proof must call this first.
 *
 * Deposits are read from the program's own `Deposited` events, in leaf order.
 */
export async function leavesFromChain(connection, poolPda, programId) {
  const { createHash } = await import("node:crypto");
  const disc = createHash("sha256").update("event:Deposited").digest().subarray(0, 8);
  const poolBytes = poolPda.toBytes();

  const signatures = [];
  for (let before; ; ) {
    const page = await connection.getSignaturesForAddress(poolPda, { limit: 1000, before });
    signatures.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }

  const found = new Map(); // leaf_index -> commitment
  // Oldest first: the tree is built in the order the chain accepted it.
  for (const { signature, err } of signatures.reverse()) {
    if (err) continue;
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    for (const line of tx?.meta?.logMessages ?? []) {
      if (!line.startsWith("Program data: ")) continue;
      const raw = Buffer.from(line.slice("Program data: ".length), "base64");
      if (raw.length < 8 + 32 + 32 + 4 + 32 + 8 || !raw.subarray(0, 8).equals(disc)) continue;
      if (!raw.subarray(8, 40).equals(Buffer.from(poolBytes))) continue;
      const commitment = BigInt("0x" + raw.subarray(40, 72).toString("hex"));
      found.set(raw.readUInt32LE(72), commitment);
    }
  }

  const leaves = [];
  for (let i = 0; i < found.size; i++) {
    const leaf = found.get(i);
    // A hole means a deposit was missed: a tree built on it would be wrong, and
    // a wrong tree means a proof that never verifies. Better to stop here.
    if (leaf === undefined) throw new Error(`missing deposit at leaf ${i}: the tree cannot be rebuilt`);
    leaves.push(leaf);
  }
  return leaves;
}
