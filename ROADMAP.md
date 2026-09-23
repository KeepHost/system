# What is left to build

The pool works on mainnet: a deposit went in, a withdrawal came out on an
address with no history, and the same receipt was refused a second time. That is
the floor, not the product. Here is the distance between the two, in the order
that matters.

Nothing here has a date. Each item is done when it is done, and this file says
which ones are started.

## 1. The ceremony, then the authority — *started*

Until the proving key stops coming from one machine, everything below is
decoration: whoever holds that machine's randomness can forge a withdrawal. A
public phase one is running (`CEREMONY.md`), it needs contributors who are not
us, and it ends with a new verifying key deployed and the upgrade authority
revoked in the same week.

Revoking before that would freeze the weakness for good, which is why the
authority is still held and why that is written on the front page.

## 2. A relayer — *the product does not work without it*

Today a withdrawal has to be submitted by someone who pays the fee. If the user
submits it from their own wallet, the wallet that paid is linked to the address
that received, and the pool has bought them nothing. The client library takes a
relayer and a fee that are both sealed inside the proof (`relayer/pool-api.mjs`
is the skeleton); it has to become a service anyone can run, and the fee has to
cover the nullifier account's rent or the relayer runs at a loss and stops.

This is the difference between a correct program and a usable one.

## 3. The pool in the browser

The site walks through a simulation. The real flow — draw a receipt, read the
tree from chain, build the Groth16 proof in a worker, hand the transaction to a
relayer — runs only from the command line today. The proof is about 8 MB of
proving key and a few seconds of work in WebAssembly: it belongs in the page,
behind a button, or the pool is for people who read Rust.

## 4. SPL tokens, then tokenized stocks

"Hold stocks. Nobody sees what." is the promise on the front page, and the pool
holds SOL and nothing else. Denominations in an SPL token mean the vault holds a
token account instead of lamports, the deposit and withdrawal move through the
token program, and the fixed sizes have to be chosen per asset. Until that is
shipped, the headline is a plan, and it should be read as one.

## 5. Association sets

The idea that makes this different from a mixer: a withdrawal proves the deposit
belongs to a set the user chose — for example, deposits with no traceable link
to flagged addresses. It needs a second Merkle inclusion in the circuit and a
published, reproducible way of building the sets. Designed, not built. Claiming
it before it exists would be the fastest way to lose the argument.

## 6. An audit

External, paid, and published with the findings — including the ones that are
not flattering. Anything else is a logo on a page.

## Deliberately not on this list

- No yield, no staking, no revenue share. The token lowers a fee and opens the
  app; that is all it will ever do.
- No admin withdrawal, no pause that can block an exit, no authority that can
  move funds. These are absences, and they are the point.
