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

## 2. A relayer — *shipped 23 September 2026*

A withdrawal has to be submitted by someone who pays the fee. Submitted from the
user's own wallet, the wallet that paid is linked to the address that received
and the pool has bought them nothing.

`relayer/pool-api.mjs` now runs as a service on keephost.fun. It announces its
address and its fee at `/pool/state`, indexes deposits at `/pool/<denom>/leaves`,
and submits withdrawals at `/pool/<denom>/withdraw`. Both the relayer address and
the fee are public inputs sealed inside the proof, so it can forward a withdrawal
or refuse it — nothing else. The fee covers the nullifier account's rent, so it
does not run at a loss.

Anyone can run another one: it is one file and one keypair holding nothing but
fees. What is missing is a way for the page to choose between several.

## 3. The pool in the browser — *shipped 23 September 2026*

The real flow runs on `/app`: the browser draws the receipt and shows it before
anything is sent, builds the Merkle path from the relayer's index, produces the
Groth16 proof locally, and hands it to the relayer. The user's wallet signs the
deposit and nothing else — a withdrawal never asks it to sign.

What is left: the proof runs on the main thread, so the page freezes for a few
seconds on a slow machine. It belongs in a worker, with a progress bar that is
not a lie.

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
