# KeepHost pool

A non-custodial shielded pool for SOL on Solana. Deposits go to a program
address with no private key. Withdrawals require a zero-knowledge proof that you
know the secret behind one deposit in the tree — without saying which one.

## Status

Deployed on Solana mainnet on 23 September 2026. **Not audited, and the proving
key comes from a ceremony run on a single machine** — read
[SECURITY.md](SECURITY.md) before you send anything. It lists what the program
guarantees, what it does not, and every step still missing.

```
program    CTHg29kf7L6TNDH5TSd3tdoZfsmP39JjyQWKmPtEY1YW
pool 0.1   E5XcHUCSzn5AtEusBT4siweDYsKkPZ2Ba7iBXVp1SVMy
pool 1     4T1wRmfivMCnC1XtU9p5Me5Z9DhEhZr8rLzSqwDMh2hV
pool 10    8tYrcp7C6PC1CD4qDXS21LoZFtbS7eG8eRPCU7SYaA9E
```

A pool address contains its creator in its seeds, so anyone can open a pool of
the same size. Those four addresses are the ones this repository deployed; check
against them, not against a link someone sends you.

The upgrade authority is **still held**, on purpose: the ceremony has to be
redone from a public phase one, and that requires redeploying. It will be
revoked once that is done — not before, because revoking now would freeze a
proving key nobody should trust.

Before that deployment, the full path ran end to end against the exact binary
that shipped: three deposits, a proof spending one of them without naming which,
the payment landing on a fresh address, and the same receipt refused the second
time.

## How it works

1. **Deposit.** Your browser draws two random numbers — a nullifier and a secret
   — and publishes only their Poseidon hash, the *commitment*. You send a fixed
   amount of SOL (0.1, 1 or 10) to the pool, and the program appends the
   commitment to an incremental Merkle tree. The chain never sees the secrets.
2. **Receipt.** The two numbers are your receipt. They are the only key to that
   deposit. Lose them and the funds stay in the tree forever; no one can recover
   them for you.
3. **Withdraw.** You build a Groth16 proof that your commitment is a leaf of a
   recent root, and that `nullifierHash` comes from your nullifier. The program
   verifies the proof on-chain, records the nullifier so the same deposit cannot
   be spent twice, and pays any address you choose.
4. **Relayer.** Because a fresh address has no SOL for fees, someone else can
   submit the transaction and take a fee. The recipient, the relayer and the fee
   are public inputs sealed inside the proof, so a relayer can only forward the
   transaction as-is, or refuse.

Fixed denominations exist on purpose: unique amounts would link a deposit to its
withdrawal without breaking any cryptography.

## Layout

```
programs/keephost-pool/src/lib.rs   the program: deposit, withdraw, pause
              src/zeros.rs          empty-tree constants (generated)
              src/verifying_key.rs  Groth16 verifying key (generated)
circuits/withdraw.circom            the circuit (Poseidon, Merkle path, binding)
client/pool.mjs                     receipts, tree, proof, byte encoding
scripts/zeros.mjs                   regenerates zeros.rs
scripts/vkey.mjs                    regenerates verifying_key.rs from the ceremony
scripts/e2e.mjs                     end-to-end: deposit, withdraw, double-spend must fail
```

## Build

Requires Rust, the Solana toolchain (Agave 2.3), Anchor 0.31.2, Node 22 and
`circom` 2.2.

```bash
# circuit + proving keys (see SECURITY.md about the ceremony)
cd circuits && npm install
circom withdraw.circom --r1cs --wasm -l node_modules -o .
# ...ceremony..., then:
node ../scripts/vkey.mjs && node ../scripts/zeros.mjs

# program
anchor build

# end to end, against a local validator
solana-test-validator -r &
solana program deploy target/deploy/keephost_pool.so
node scripts/e2e.mjs
```

## What the program cannot do

There is no admin withdrawal, no authority over the vault, no account-closing
path that drains it, and no upgrade of state that moves lamports. The only
instruction that moves funds out is `withdraw`, and only after a valid proof.
`set_paused` flips one boolean that blocks *new deposits*; withdrawals keep
working while paused.

If you find a way to take a lamport that is not a valid withdrawal, that is a
critical bug — see the reporting section of SECURITY.md.

## Licence

MIT. See [LICENSE](LICENSE).
