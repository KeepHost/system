# Break it

There is no external audit. Instead of claiming one, here is the honest
substitute: the pools hold real SOL on mainnet, nobody holds a key to them, and
the rules below say exactly what taking it would prove.

## The standing bounty

At the time of writing the vaults hold **0.502 SOL**, most of it in the 0.1 SOL
pool. Check for yourself:

```bash
curl -s https://keephost.fun/pool/state
```

Nobody can move that SOL except through `withdraw`, and `withdraw` pays only
after a Groth16 proof verifies on chain. **If you can take it without holding a
receipt, it is yours.** No permission needed, no disclosure required, no hard
feelings. A pool that can be emptied by a stranger should be emptied by a
stranger rather than by a user.

That is not a generous offer. It is the only test that means anything.

## What counts as breaking it

Any of these is a critical finding:

- a withdrawal that pays out without a valid receipt — a forged proof, a reused
  nullifier, a malleable public input, a root that was never stored;
- a way to withdraw more than one deposit with one receipt, or to withdraw from
  a pool you never deposited into;
- a way to make a deposit that the tree records incorrectly, so that an honest
  user's later proof cannot verify — funds locked are as bad as funds stolen;
- a relayer that can redirect a withdrawal, raise its fee, or learn which
  deposit is being spent;
- anything that moves lamports out of a vault other than `withdraw`.

Out of scope, because they are documented and already true: the proving key
comes from a ceremony run on this project's own machines (see
[CEREMONY.md](CEREMONY.md) — you can fix that by contributing), the upgrade
authority still exists, and the anonymity set is small because the pool is new.

## Where to look

- `programs/keephost-pool/src/lib.rs` — 470 lines. Instruction handlers,
  account constraints, the incremental tree, the public input encoding.
- `circuits/withdraw.circom` — the constraint system. Under-constrained signals
  are where these things usually die.
- `client/pool.mjs` — proof construction, byte encoding, tree reconstruction.
- `relayer/pool-api.mjs` — what a hostile relayer can and cannot do.

Two places worth starting: the way a 32-byte address is split into two field
elements before it enters the proof, and the order of the nine public inputs
where the program and the circuit have to agree exactly.

## Reporting instead of taking

If you would rather report than drain, or if you find something that would hurt
users more than it would pay you:

- open a GitHub issue for anything that is not exploitable, or
- write to the address in [SECURITY.md](SECURITY.md) for anything that is.

Reports that hold up get paid out of the creator-fee wallet, published with the
finding, and credited by name unless you ask otherwise. The amount depends on
what that wallet holds; it will be stated in the reply before any fix ships, not
haggled afterwards.

## What happens to a confirmed finding

It gets written into this repository with the transaction that proved it, fixed,
and the fix redeployed — the upgrade authority exists precisely so that is
possible. If it cannot be fixed, the pools get drained to their depositors and
the project says so.

Nothing here is a hypothetical. The SOL is on chain, the code is in this
repository, and the test that is supposed to prevent all of the above runs on
every commit.
