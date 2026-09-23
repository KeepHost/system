<h1 align="center">KeepHost</h1>

<p align="center">
  A non-custodial shielded pool for SOL on Solana.<br>
  Deposits land on an address with no private key. Withdrawals take a
  zero-knowledge proof that you own one deposit — without saying which.
</p>

<p align="center">
  <a href="https://github.com/KeepHost/system/actions/workflows/test.yml"><img alt="test" src="https://github.com/KeepHost/system/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://github.com/KeepHost/system/actions/workflows/audit.yml"><img alt="audit" src="https://github.com/KeepHost/system/actions/workflows/audit.yml/badge.svg"></a>
  <a href="https://solscan.io/account/CTHg29kf7L6TNDH5TSd3tdoZfsmP39JjyQWKmPtEY1YW"><img alt="mainnet: live" src="https://img.shields.io/badge/mainnet-live-brightgreen"></a>
  <a href="https://solscan.io/tx/WXLawCeXKXV2DsjAeFhaYBGWzqBNz4gmmSYKpRxP9urSwtpGBazq7wDgtW55jsXdceHcYKRfbAaPBaVGWA3aeEy"><img alt="withdrawal: verified on chain" src="https://img.shields.io/badge/withdrawal-verified%20on%20chain-brightgreen"></a>
  <a href="CEREMONY.md"><img alt="ceremony: open" src="https://img.shields.io/badge/ceremony-open-blue"></a>
  <a href="LICENSE"><img alt="licence MIT" src="https://img.shields.io/badge/licence-MIT-black"></a>
</p>

<p align="center">
  <a href="https://keephost.fun">keephost.fun</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CEREMONY.md">Ceremony</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="https://x.com/KeepHostLedger">@KeepHostLedger</a>
</p>

---

> **Where this stands.** The program is live, **not audited**, and its proving
> key came from a ceremony run on a single machine — whoever held that machine's
> randomness could forge a withdrawal. The public ceremony that replaces it is
> [open to anyone](CEREMONY.md), and until the new key ships the upgrade
> authority is deliberately kept so it *can* ship. That authority lives on an
> offline wallet, not on the server: taking the machine no longer means taking
> the program.

## Addresses

Deployed to Solana mainnet on 23 September 2026.

| | Address |
|---|---|
| Program | [`CTHg29kf7L6TNDH5TSd3tdoZfsmP39JjyQWKmPtEY1YW`](https://solscan.io/account/CTHg29kf7L6TNDH5TSd3tdoZfsmP39JjyQWKmPtEY1YW) |
| Pool · 0.1 SOL | [`E5XcHUCSzn5AtEusBT4siweDYsKkPZ2Ba7iBXVp1SVMy`](https://solscan.io/account/E5XcHUCSzn5AtEusBT4siweDYsKkPZ2Ba7iBXVp1SVMy) |
| Pool · 1 SOL | [`4T1wRmfivMCnC1XtU9p5Me5Z9DhEhZr8rLzSqwDMh2hV`](https://solscan.io/account/4T1wRmfivMCnC1XtU9p5Me5Z9DhEhZr8rLzSqwDMh2hV) |
| Pool · 10 SOL | [`8tYrcp7C6PC1CD4qDXS21LoZFtbS7eG8eRPCU7SYaA9E`](https://solscan.io/account/8tYrcp7C6PC1CD4qDXS21LoZFtbS7eG8eRPCU7SYaA9E) |
| Token | [`4c1XZRqFV6y8pAckHru5oiGPYUFw1eQ3kFotPLHrpump`](https://solscan.io/token/4c1XZRqFV6y8pAckHru5oiGPYUFw1eQ3kFotPLHrpump) |

A pool address carries its creator inside its seeds, so **anyone can open a pool
of the same size**. The three above are the ones this repository deployed: check
against this table, not against a link someone sends you.

The token paid the rent Solana charges to store the program. It is not a share,
it pays nothing, and the pool takes no token to use.

## It has been used

The whole path ran on mainnet against the binary that shipped:

| | Signature |
|---|---|
| Deposit · 0.1 SOL | [`2YVU31sk…D7Cn27g9`](https://solscan.io/tx/2YVU31skhcv6BPAjHojugqgUPuF4PpehrmpS1XvCnUiGJJC5mZoB7XgHjVQYyK1kEs9hU5y6ec5TkiW3D7Cn27g9) |
| Withdrawal · nine slots later | [`WXLawCeX…GWA3aeEy`](https://solscan.io/tx/WXLawCeXKXV2DsjAeFhaYBGWzqBNz4gmmSYKpRxP9urSwtpGBazq7wDgtW55jsXdceHcYKRfbAaPBaVGWA3aeEy) |

One address paid in; a different address, with no history and no funding, was
paid out. The program verified that one leaf of the tree belonged to whoever
asked, without learning which. The same receipt, presented a second time, was
refused.

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
