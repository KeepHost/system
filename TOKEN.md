# What the token is for

$KEEPHOST is not a share, pays no yield, and gives no claim on anything. The
pool takes no token to use: anyone can deposit and withdraw without holding one,
and that will not change.

So it needs a reason to exist that survives being read carefully. Here it is.

## The problem nobody talks about: somebody has to send the withdrawal

A shielded pool hides the link between a deposit and a withdrawal. It cannot
hide who paid the transaction fee.

Withdraw to a fresh address and that address has no SOL, so it cannot pay. Pay
from the wallet you were trying to leave behind and you have just signed the
link you spent money to erase. The way out is a **relayer**: someone else
submits your withdrawal and takes a fee, with the recipient, the relayer and the
fee sealed inside your proof, so they can forward it or refuse it and nothing
else.

That means the privacy of this pool depends on relayers existing, staying
funded, and not all being the same person. Today there is one, it is ours, and
it holds a fraction of a SOL. An adversarial review put it plainly: a single
relayer can silently censor a withdrawal, and one operator watching both the
index and the submission can correlate a deposit with its withdrawal.

**That is the weakest part of the whole design, and it is an economic problem,
not a cryptographic one.** No amount of circuit work fixes it. Someone has to
want to run a relayer.

## What the token does about it

Every deposit pays a small fee. The fee does not go to a company — it goes to a
PDA, an address with no private key, and it pays for the two things the pool
cannot run without:

1. **Relayers.** A relayer's real cost is the rent of the nullifier account it
   creates for you: 0.001016 SOL at today's rates, checked on chain. The fee
   covers that plus a margin, so running one is profitable rather than
   charitable. The more relayers exist, the less any single one can censor or
   correlate — and anyone can run one from a single file.
2. **Holders pay less.** Holding the token lowers your own deposit fee. That is
   the only benefit it confers, and it is a discount, never a payout.

What is left over is bought back on the market and burned by an instruction
**anyone** can call — not ours to run, and not ours to withhold.

## What it has already paid for

This is the part that is not a plan. The token's creator fees paid the rent
Solana charges to store the program: that transaction is what put a working
shielded pool on mainnet, and the wallet is on the front page, read from the
chain every fifteen seconds.

Next, in order, the treasury pays for: the redeploy carrying the new proving key
and association sets, funding relayers so withdrawals stay cheap to submit, and
an external audit once it covers one.

## What is live and what is not, today

| | |
|---|---|
| Creator fees paid for the mainnet deployment | **done, on chain** |
| Holding opens the pool pages | **live** |
| Deposit fee, lower for holders | written, not deployed |
| Fees fund relayers | written, not deployed |
| Buy-back and burn, callable by anyone | designed |
| A capped access key you burn tokens to mint | designed |

Nothing in the second half of that table is running. When it is, this file says
so with the transaction that made it true, and not before.

## What it is not

Not a security. Not a share of revenue. Not a claim on the pool's deposits —
those belong to whoever holds the receipt and to nobody else, including every
token holder on earth. Its price comes from a market, not from a promise made
here.
