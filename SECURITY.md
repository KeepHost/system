# Security

This file states what is true today. It is updated at every step. If anything
here contradicts the website, this file is right.

## What the program guarantees by construction

- **Funds live on a PDA** (`seeds = ["vault", pool]`): an address with no private
  key. No human can sign for it.
- **One instruction moves funds out**: `withdraw`, and only after a Groth16 proof
  verifies. There is no admin withdrawal, no authority transfer, and no
  account-closing path that drains the vault. Read
  `programs/keephost-pool/src/lib.rs` and check.
- **No double withdrawal**: each withdrawal creates a `nullifier` account derived
  from the `nullifierHash`. If that account already exists, the transaction
  fails.
- **A relayer cannot redirect anything**: the recipient address and the fee are
  public inputs sealed inside the proof. Changing either invalidates it.
- **The pause key cannot touch funds**: `set_paused` flips one boolean that
  blocks *new deposits*. Withdrawals work whether the pool is paused or not.

## What is NOT guaranteed today

1. **The code is not audited.** It was written and reviewed by its author, which
   is not an independent audit. While this line is here, deposit only what you
   are willing to lose.
2. **The trusted setup had one participant** — the development machine, phase one
   included. Whoever held that machine's randomness could forge proofs and empty
   a pool. This is the single most serious open item. Fixing it means starting
   again from a public phase one (the Hermez `powersOfTau28_hez_final_14.ptau`),
   running a phase two with independent contributors, and redeploying. The
   security then holds as soon as **one** participant was honest and destroyed
   their randomness.
3. **The upgrade authority still exists**, and whoever holds it can replace the
   code and therefore bypass everything else. It is held deliberately, because
   fixing point 2 requires a redeploy, and it will be revoked once that is done.
   Since 23 September 2026 it is **no longer held by a key on the server**: it
   sits on `5h11Ec9feUdgUyci1Bgeh4DJqA6MVebRhgr6Lr4F85yt`, a wallet that never
   touches the machine serving this site — so taking the server no longer means
   taking the program. Check it yourself with
   `solana program show CTHg29kf7L6TNDH5TSd3tdoZfsmP39JjyQWKmPtEY1YW`.
4. **Privacy is not absolute.** It comes from the size of the crowd and from your
   own habits:
   - a nearly empty pool hides nearly nothing;
   - withdrawing seconds after depositing links the two;
   - reusing the same withdrawal address links your withdrawals together;
   - the deposit side is public: anyone can see that an address deposited, but
     not what it withdraws later.
5. **A relayer sees things**: the destination address and your IP at the moment
   of the request. It cannot steal, but it can log. The relayer code is in this
   repository, and anyone can run a different one.

## Threat model, in one sentence

An attacker who controls the web server, the relayer and the network must not be
able to take a single lamport. They can degrade the service (refuse to forward)
and observe metadata. Stealing funds requires breaking Groth16 or holding the
ceremony's randomness — hence point 2.

## Adversarial review, 22 September 2026

A review was run against the code with one instruction: find a way to steal the
funds. It found some. Here are the findings and what became of them. This is the
kind of list an honest project publishes, because a project without one simply
never looked.

| # | Finding | State |
|---|---------|-------|
| C1 | The embedded verifying key was a zero-filled template: it would have accepted any proof, so anyone could empty the vault without ever depositing. | **Made impossible**: the program now refuses to compile if the key is degenerate or if the number of public inputs does not match the circuit. |
| E1 | A public key reduced modulo p has about 5 representations: a relayer could redirect a withdrawal to a twin address with no private key — funds lost, proof still valid. | **Fixed**: addresses enter the proof as two 16-byte halves, so the encoding is injective in circuit, program and client. |
| E2 | The relayer index read every log: anyone could imitate the event discriminator from their own program and poison the tree. | **Fixed**: only logs written between the invocation and the end of OUR program count, and the leaf index is bounded. |
| E3 | The leaf list existed only in memory and in RPC history, which public nodes prune: after a while nobody could build a proof, so nobody could withdraw. | **Mitigated**: the index is written to disk, and the receipt carries the pool and the leaf index. Still to do: an independent archive indexer. |
| E4 | One lamport of dust sent to the vault permanently blocked the last withdrawal (it fell below the rent-exempt minimum). | **Fixed**: the vault is funded to that minimum when the pool opens, and the denomination must cover it. |
| E5 | `initialize` was open to anyone: a stranger could open the canonical denomination before us and keep its pause key forever. | **Fixed**: the creator is part of the pool seeds, and an instruction renounces the pause for good. |
| M1 | Thirty-one roots were zero in a fresh pool: a root that never existed counted as known. | **Fixed**: every entry holds the empty-tree root, and the zero root is refused. |
| M2 | A proof was not bound to any pool. | **Fixed**: the pool is a public input of the proof. |
| M3 | An attacker can flood the anonymity set, and 32 deposits were enough to expire proofs in flight. | **Mitigated**: the root window is 32 entries and the account stays small. The rest is inherent to this kind of pool. |
| M5 | The relayer paid the rent of the anti-double-spend account with a default fee of zero: it drained itself at every withdrawal. | **Fixed**: the default fee covers that rent. |
| M7 | The equivalence between Solana's Poseidon syscall and circomlib's had never been checked in this repository. | **Covered in practice**: the end-to-end test builds a proof with circomlib and spends it against the on-chain program, which fails if the two disagree. A dedicated vector test is still worth adding. |
| F1 | Modulo bias when drawing secrets. | **Fixed**: rejection sampling. |

Privacy findings that code cannot fix, written here instead: the size of the
anonymity set is publicly computable (vault balance divided by the denomination),
and the pause authority could freeze it at the worst moment — hence the
renounce instruction.

## Steps before deserving your trust

- [x] Program written, with no admin path over the funds
- [x] Proof verified on-chain (alt_bn128 syscalls), Poseidon via syscall
- [x] Internal adversarial review, findings published above
- [x] End-to-end test on a local validator: deposit, proof, withdrawal, and a
      second withdrawal refused, run against the exact binary that shipped
- [x] Deployed on mainnet, three pools open
- [ ] Multi-participant ceremony from a public phase one, then redeploy
- [ ] External audit, report published
- [ ] Upgrade authority revoked
- [x] Browser deposit and withdrawal, so using this needs no terminal
- [x] A relayer, so a withdrawal is not signed by the wallet that deposited

## Reporting a problem

Open a public issue if it is not exploitable. If it is, write to the maintainer
privately first and leave time for a fix.
