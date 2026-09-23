# Deploying

## What is deployed today

```
program    CTHg29kf7L6TNDH5TSd3tdoZfsmP39JjyQWKmPtEY1YW
pool 0.1   E5XcHUCSzn5AtEusBT4siweDYsKkPZ2Ba7iBXVp1SVMy
pool 1     4T1wRmfivMCnC1XtU9p5Me5Z9DhEhZr8rLzSqwDMh2hV
pool 10    8tYrcp7C6PC1CD4qDXS21LoZFtbS7eG8eRPCU7SYaA9E
```

Deployed 23 September 2026 from the binary produced by `cargo build-sbf`, after
the end-to-end test passed against that exact file. The upgrade authority is
still held; see step 3.

## 1. The ceremony — the open item

The proving key currently in this repository was produced on a single machine,
phase one included. Whoever held that machine's randomness can forge a
withdrawal proof. Fixing it requires starting from a public phase one:

```bash
# 1. public phase one, from the Hermez ceremony
curl -L -o pot14.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau

# 2. phase two, once per contributor; type anything at the prompt
npx snarkjs groth16 setup circuits/withdraw.r1cs pot14.ptau withdraw_0000.zkey
npx snarkjs zkey contribute withdraw_0000.zkey withdraw_0001.zkey --name="<your name>" -v

# 3. each contributor sends back their .zkey and the hash printed at the end,
#    then closes the terminal and forgets what they typed — that is the point

# 4. verify the chain of contributions, then publish every hash
npx snarkjs zkey verify circuits/withdraw.r1cs pot14.ptau withdraw_final.zkey
```

Then regenerate the verifying key, rebuild, and redeploy:

```bash
node scripts/vkey.mjs      # rewrites programs/keephost-pool/src/verifying_key.rs
cargo build-sbf
node scripts/e2e.mjs       # against a local validator, before anything else
```

The security holds as soon as **one** contributor was honest and destroyed their
randomness. More contributors can only help.

## 2. Deploying

```bash
# devnet first, where SOL is free
solana config set --url devnet
solana program deploy target/deploy/keephost_pool.so --program-id keys/program.json

# mainnet, the day you decide (budget ~2.6 SOL of rent)
solana config set --url mainnet-beta
solana program deploy target/deploy/keephost_pool.so --program-id keys/program.json
```

Then open the pools. The creator is part of a pool's seeds, so the keypair used
here determines the pool addresses — use the same one every time:

```bash
node scripts/init.mjs --url mainnet --keypair keys/deployer.json --denom 100000000     # 0.1 SOL
node scripts/init.mjs --url mainnet --keypair keys/deployer.json --denom 1000000000    # 1 SOL
node scripts/init.mjs --url mainnet --keypair keys/deployer.json --denom 10000000000   # 10 SOL
```

The script is idempotent: run it again and it reports the existing addresses
without sending a transaction.

## 3. Revoking the upgrade authority

While the authority exists, whoever holds it can replace the code and therefore
bypass every guarantee. It must be revoked before strangers put money in:

```bash
solana program set-upgrade-authority <PROGRAM_ID> --final
```

This is irreversible — no correction is possible afterwards. It is deliberately
**not** done yet, because the ceremony above requires a redeploy. Revoking now
would freeze a proving key nobody should trust.

## 4. Verifying, at any time

```bash
solana program show <PROGRAM_ID>   # upgrade authority, size, balance
solana account <VAULT_PDA>         # what the vault holds
```

What a sceptical reader should be able to establish alone: the vault is a PDA
with no key, the program is immutable once step 3 is done, and the published
source matches the deployed program (`solana-verify`, or a reproducible build).

## Keys

No key of value belongs on a web server. `keys/` is gitignored and never
published. The only key that may sit on a server is a relayer key, which holds
only what it needs for fees.
