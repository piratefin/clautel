import crypto from "node:crypto";
import express from "express";
import { webhookCallback } from "grammy";
import { createBot } from "./bot.js";
import { startTunnel, stopTunnel } from "./tunnel.js";
import { cancelQuery } from "./claude.js";

const PORT = 3000;
const webhookSecret = crypto.randomUUID();

async function main() {
  const bot = createBot();

  // Get bot info
  const me = await bot.api.getMe();
  console.log(`Bot: @${me.username}`);

  // Express server
  const app = express();
  app.post(
    "/webhook",
    webhookCallback(bot, "express", { secretToken: webhookSecret })
  );
  app.get("/health", (_req, res) => res.send("ok"));

  const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });

  // Start ngrok tunnel and register webhook
  const url = await startTunnel(bot, PORT, webhookSecret);
  console.log(`Ready! Send a message to @${me.username}`);
  console.log(`Webhook: ${url}/webhook`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await stopTunnel();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
