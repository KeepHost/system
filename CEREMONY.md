# The ceremony

The proving key that secures every withdrawal was produced on one machine. That
is the weakest thing about KeepHost, it is written in `SECURITY.md`, and this
file is how it gets fixed.

## Why it matters

A Groth16 setup produces a proving key and, as a by-product, a piece of
randomness usually called toxic waste. Anyone holding that randomness can forge
a proof — a withdrawal for a deposit they never made — and empty a pool without
breaking a single hash. The defence is not secrecy. It is that the randomness is
produced in pieces by many people, and **the setup is safe as long as at least
one of them destroyed their piece**.

The key currently deployed does not have that property. One machine produced all
of it.

## What is being done

The usual fix is to start from the Hermez perpetual powers-of-tau, a phase one
run by hundreds of participants. Its official mirrors have been returning 403
since 14 September 2026 ([snarkjs#636](https://github.com/iden3/snarkjs/issues/636)),
so KeepHost runs its own phase one in the open instead.

Phase one started on 23 September 2026. First contribution hash:

```
bc0bde79 80381fa6 42b20975 91dd83f1
ed15b003 e15c3552 0af32c95 eb519149
2a6f3175 215635cf c10e6098 e2c612d0
ca84f1a9 f90b5333 560c8af5 9b9209f4
```

The current file is published at
<https://keephost.fun/ceremony/pot14_0001.ptau>.

## How to contribute (about two minutes)

You need Node. Nothing else, and nothing to install permanently.

```bash
curl -L -o pot_in.ptau https://keephost.fun/ceremony/pot14_0001.ptau
npx snarkjs powersoftau verify pot_in.ptau
npx snarkjs powersoftau contribute pot_in.ptau pot_out.ptau --name="<your name>" -v
```

It asks you to type random characters. Type whatever you want, then send back
`pot_out.ptau` and the contribution hash it prints. **Do not keep the text you
typed, and do not keep the machine's memory of it** — forgetting it is the whole
job. Close the terminal.

Two things worth knowing before you do it:

- the `verify` line is not decoration. It checks that the file you received
  chains correctly onto every contribution before yours. Run it, and do not
  contribute to a file that fails it;
- your contribution cannot make the setup worse. It can only add one more piece
  of randomness that somebody would have to obtain. Even a careless participant
  is harmless; the setup only fails if *everyone* keeps their piece.

## What happens after

When the contributions stop, phase one is finalised with a public beacon, the
circuit-specific phase two runs the same way, and the new verifying key replaces
the current one in the program. That replacement is the reason the upgrade
authority is still held: revoking it today would freeze the weakness for good.

Once the new key is deployed and the program has been checked against it, the
authority is revoked — and that is the point where nobody, including us, can
change anything about this pool ever again.

## Verifying the result yourself

Every contribution is chained and every hash is public, so anyone can replay the
whole transcript:

```bash
# phase one: every contribution chains onto the one before it
npx snarkjs powersoftau verify <final ptau>

# phase two: the proving key belongs to this circuit and that phase one
npx snarkjs zkey verify circuits/withdraw.r1cs <final ptau> <zkey>

# the key compiled into the program is the one that key produces:
# regenerating it must change nothing
node scripts/vkey.mjs
git diff --exit-code programs/keephost-pool/src/verifying_key.rs
```

If any of those three fail, the program on mainnet is not the one this
repository describes, and you should say so loudly.
