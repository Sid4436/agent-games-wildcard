#!/usr/bin/env bash
# Re-download the official Agent Games circuit artifacts and verify them.
# Usage: npm run download-circuits
# Artifacts are committed in circuits/ (total ~5.9 MB); this script is for
# refreshing them or verifying a fresh checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

declare -A URLS=(
  [gatekeeper.wasm]="https://agentgames.zkverify.io/circuits/gatekeeper.wasm"
  [gatekeeper_final.zkey]="https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey"
  [vfy-policy.wasm]="https://agentgames.zkverify.io/circuits/vfy-policy.wasm"
  [vfy-policy_final.zkey]="https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey"
)
declare -A SHA256=(
  [gatekeeper.wasm]="be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f"
  [gatekeeper_final.zkey]="adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d"
  [vfy-policy.wasm]="bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2"
  [vfy-policy_final.zkey]="f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41"
)

mkdir -p circuits
for f in "${!URLS[@]}"; do
  echo "downloading circuits/$f ..."
  curl -sL --max-time 180 -o "circuits/$f" "${URLS[$f]}"
  actual="$(sha256sum "circuits/$f" | cut -d' ' -f1)"
  if [ "$actual" != "${SHA256[$f]}" ]; then
    echo "SHA256 MISMATCH for circuits/$f: got $actual, expected ${SHA256[$f]}" >&2
    exit 1
  fi
  echo "  ok ($(stat -c%s "circuits/$f") bytes, sha256 verified)"
done

echo "exporting verification keys ..."
npx snarkjs zkev circuits/gatekeeper_final.zkey circuits/gatekeeper_vk.json
npx snarkjs zkev circuits/vfy-policy_final.zkey circuits/vfy-policy_vk.json
echo "done."
