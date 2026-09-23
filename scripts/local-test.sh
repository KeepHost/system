#!/usr/bin/env bash
# Full test on a local validator: starts it, loads the program, runs the
# end-to-end test.
#
#   scripts/local-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/solana/v4.2.2/bin:$HOME/.cargo/bin:$PATH"
LEDGER=${LEDGER:-/tmp/keephost-validator}
PROGRAM=$(grep -m1 'keephost_pool = ' Anchor.toml | cut -d'"' -f2)

pkill -f "solana-test-validator --ledger $LEDGER" 2>/dev/null || true
rm -rf "$LEDGER"
solana-test-validator --ledger "$LEDGER" --reset --quiet \
  --bpf-program "$PROGRAM" target/deploy/keephost_pool.so > /tmp/validator.log 2>&1 &
VALIDATOR=$!
trap 'kill $VALIDATOR 2>/dev/null || true' EXIT

for i in $(seq 60); do
  solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 && break
  sleep 1
done
echo "validator ready · program $PROGRAM"
solana program show "$PROGRAM" --url http://127.0.0.1:8899 | head -4 || true
node scripts/e2e.mjs --url http://127.0.0.1:8899
