# Association sets

The thing that makes this not a mixer, and the reason the circuit changed.

## The problem it solves

A shielded pool hides everyone equally. That is its strength and it is what
killed the category: honest users end up sharing an anonymity set with stolen
funds, exchanges start refusing withdrawals that came out of the pool, and the
tool dies of its own reputation. No amount of cryptography fixes that, because
the cryptography is working exactly as designed.

The published answer is to let a user prove *more* than "I own some deposit in
this pool". They also prove "and that deposit belongs to a set I chose" — for
example, a set built to exclude deposits traceable to sanctioned addresses or
known thefts. The idea comes from *Blockchain Privacy and Regulatory Compliance:
Towards a Practical Equilibrium* (Buterin, Illum, Nadler, Schär, Soleimani,
2023), and 0xbow shipped it on Ethereum in March 2025.

Nothing about it is a backdoor. The user picks the set. Nobody can force one,
nobody can revoke a deposit, and a withdrawal still says nothing about which
deposit paid it.

## How it works here

A set is a second Merkle tree whose leaves are commitments already in the pool —
a subset, chosen and published by whoever builds it. The withdrawal proof now
carries two inclusions of the same commitment:

1. in the pool's tree, whose root the program already knows;
2. in the set's tree, whose root is a public input of the proof.

Both are proved without revealing which leaf. An observer learns that the
withdrawal came from *a* deposit inside *that* set, and nothing else.

Whoever cares — an exchange, an auditor, a counterparty — reads the set root
from the transaction and decides for itself what that set is worth. The program
does not rank sets and never will: it records which one was used and leaves the
judgement to the person who needs it.

## What it costs

The second inclusion roughly doubles the circuit: 11,000 constraints became
21,739. That is above 2^14, so the trusted setup has to start from 2^15 powers
of tau — which is why the ceremony was restarted at that size on 24 September
2026, with two contributions discarded. Both were ours, so no contributor lost
anything.

Proving takes longer in the browser, on the order of a few seconds more. The
proof and the on-chain verification cost the same: Groth16 does not grow with
the circuit.

## What is built, and what is not

- [x] The circuit: a second Merkle inclusion, with `assocRoot` as a tenth public
      input (`circuits/withdraw.circom`).
- [ ] The program: a registry of published set roots, and a withdrawal that
      records which one was used.
- [ ] The set builder: a reproducible script that turns a public screening list
      into a set, so anyone can rebuild a set and check it matches its root.
- [ ] The page: choosing a set, with what each one excludes written plainly.

Until all four exist, this file describes a design, not a feature. The site says
so too.

## The honest limits

- A set is only as good as whoever built it, and any set can be built. A set
  containing one deposit proves nothing to anyone, which is why what matters is
  *who published* the set, not that a set was used.
- Excluding deposits shrinks the crowd that hides you. A set is a trade between
  privacy and acceptability, and it should be presented as one.
- None of this makes the pool "compliant". It gives a user a way to show
  something true about their own money, to someone who asked.
