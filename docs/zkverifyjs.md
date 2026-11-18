# zkVerifyJS alternative (direct chain interaction)

The default submission path in this repo is **Kurier REST** (`src/submission.ts`:
`KurierSubmissionProvider`), because it needs no funded on-chain account —
only an API key from https://kurier.xyz (mainnet) or
https://testnet.kurier.xyz (testnet).

The documented alternative from the Agent Games /build guide is **zkVerifyJS**
(direct chain interaction from TypeScript). It is NOT wired in by default,
because it requires:

1. A **funded Volta account** (Volta is zkVerify's testnet; the session needs
   funds to pay for proof submission), and
2. The `zkverifyjs` package + a session setup (`startSession`, proof
   configuration, submit, listen for inclusion/finalization events).

## How to swap it in

Implement the `SubmissionProvider` interface (`src/submission.ts`) with a
`ZkVerifyJsSubmissionProvider`:

```ts
import { zkVerifySession, ... } from "zkverifyjs"; // see docs.zkverify.io

export class ZkVerifyJsSubmissionProvider implements SubmissionProvider {
  readonly name = "zkverifyjs";
  async submit(circuit, proof, publicSignals, vkHash): Promise<SubmissionReceipt> {
    // 1. Start a Volta session with the funded account.
    // 2. Select the proof configuration (groth16 / bn128, vkHash).
    // 3. Submit { proof, publicSignals } and wait for the Finalized event.
    // 4. Return { status: "Finalized", proofReference: <tx/hash> }.
  }
}
```

Then select it in `src/index.ts` (e.g. `SUBMISSION_PROVIDER=zkverifyjs`).

Reference: https://docs.zkverify.io/overview/getting-started/zkverifyjs
(and the "Verifying proofs with zkVerifyJS" tutorial linked from the Kurier
docs page). Do NOT put the Volta account's private key in the repo — load it
from the environment like every other secret (see `.env.example`).
