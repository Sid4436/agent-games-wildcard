/**
 * Entrypoint: load config, build the submission provider, start the server.
 *
 * Usage:
 *   npm run dev    (tsx, live reload-free)
 *   npm start      (compiled output in dist/)
 *
 * Required for live mode: AGENT_GAMES_HMAC_SECRET (from the platform
 * dashboard) and, for Kurier submission, KURIER_API_KEY. Without the HMAC
 * secret the server runs in DEMO mode (HMAC verification skipped) — local
 * testing only, never deploy that.
 */
import { loadConfig } from "./config.js";
import { createAgentServer } from "./server.js";
import {
  KurierSubmissionProvider,
  OfflineSubmissionProvider,
  type SubmissionProvider,
} from "./submission.js";

async function main(): Promise<void> {
  const config = loadConfig();

  let provider: SubmissionProvider;
  if (config.submissionProvider === "kurier") {
    if (!config.kurierApiKey) {
      console.error(
        "[agent] SUBMISSION_PROVIDER=kurier but KURIER_API_KEY is not set. " +
          "Falling back to the offline provider.",
      );
      provider = new OfflineSubmissionProvider(config.rootDir);
    } else {
      provider = new KurierSubmissionProvider(
        config.kurierApiKey,
        config.kurierNetwork,
      );
    }
  } else {
    provider = new OfflineSubmissionProvider(config.rootDir);
  }

  const server = createAgentServer(config, provider);
  await server.listen();

  const shutdown = async (): Promise<void> => {
    console.log("[agent] shutting down");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[agent] fatal:", error);
  process.exit(1);
});
