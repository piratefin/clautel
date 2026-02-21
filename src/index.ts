import crypto from "node:crypto";
import express from "express";
import { Bot } from "grammy";
import { config } from "./config.js";
import { startTunnel, stopTunnel } from "./tunnel.js";
import { ClaudeBridge } from "./claude.js";
import { createManager } from "./manager.js";
import { createWorker } from "./worker.js";
import { loadBots, addBot, removeBot } from "./store.js";
import type { BotConfig } from "./store.js";

const PORT = 3000;

interface ActiveWorker {
  config: BotConfig;
  bot: Bot;
  bridge: ClaudeBridge;
  secretToken: string;
}

const activeWorkers = new Map<number, ActiveWorker>();
let tunnelUrl = "";
let managerSecretToken = "";

async function startWorker(botConfig: BotConfig): Promise<void> {
  const bridge = new ClaudeBridge(botConfig.id, botConfig.workingDir, botConfig.username);
  const bot = createWorker(botConfig, bridge);
  const secretToken = crypto.randomUUID();

  // Initialize bot (fetches bot info)
  await bot.init();

  // Register webhook
  const webhookUrl = `${tunnelUrl}/webhook/${botConfig.id}`;
  await bot.api.setWebhook(webhookUrl, { secret_token: secretToken });

  activeWorkers.set(botConfig.id, { config: botConfig, bot, bridge, secretToken });

  // Persist to store
  addBot(botConfig);

  console.log(`Worker started: @${botConfig.username} → ${botConfig.workingDir}`);
}

async function stopWorker(botId: number): Promise<void> {
  const worker = activeWorkers.get(botId);
  if (!worker) return;

  // Abort all active queries
  worker.bridge.abortAll();

  // Delete webhook
  try {
    await worker.bot.api.deleteWebhook();
  } catch {}

  activeWorkers.delete(botId);

  // Remove from persistent store
  removeBot(botId);

  console.log(`Worker stopped: @${worker.config.username}`);
}

function getActiveWorkers(): Map<number, { config: BotConfig }> {
  const result = new Map<number, { config: BotConfig }>();
  for (const [id, w] of activeWorkers) {
    result.set(id, { config: w.config });
  }
  return result;
}

function getTunnelUrl(): string {
  return tunnelUrl;
}

async function main() {
  // 1. Start Express server
  const app = express();
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => res.send("ok"));

  // Manager webhook
  app.post("/webhook/manager", (req, res) => {
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    if (secret !== managerSecretToken) {
      res.sendStatus(403);
      return;
    }
    managerBot.handleUpdate(req.body).catch((err) => {
      console.error("[manager] Update error:", err.message);
    });
    res.sendStatus(200);
  });

  // Worker webhooks (dynamic routing)
  app.post("/webhook/:botId", (req, res) => {
    const botId = Number(req.params.botId);
    const worker = activeWorkers.get(botId);
    if (!worker) {
      res.sendStatus(404);
      return;
    }

    const secret = req.headers["x-telegram-bot-api-secret-token"];
    if (secret !== worker.secretToken) {
      res.sendStatus(403);
      return;
    }

    worker.bot.handleUpdate(req.body).catch((err) => {
      console.error(`[${worker.config.username}] Update error:`, err.message);
    });
    res.sendStatus(200);
  });

  const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });

  // 2. Start ngrok tunnel
  tunnelUrl = await startTunnel(PORT);

  // 3. Create and register manager bot
  const managerBot = createManager({
    startWorker,
    stopWorker,
    getActiveWorkers,
    getTunnelUrl,
  });

  await managerBot.init();
  const managerInfo = await managerBot.api.getMe();
  managerSecretToken = crypto.randomUUID();
  await managerBot.api.setWebhook(`${tunnelUrl}/webhook/manager`, {
    secret_token: managerSecretToken,
  });
  console.log(`Manager bot: @${managerInfo.username}`);

  // 4. Restore saved workers
  const savedBots = loadBots();
  for (const botConfig of savedBots) {
    try {
      await startWorker(botConfig);
    } catch (err) {
      console.error(`Failed to restore worker @${botConfig.username}:`, err);
    }
  }

  console.log(`\nReady! DM @${managerInfo.username} to manage bots`);
  console.log(`Active workers: ${activeWorkers.size}`);
  console.log(`Tunnel: ${tunnelUrl}`);

  // 5. Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");

    // Stop all workers
    for (const [botId] of activeWorkers) {
      const worker = activeWorkers.get(botId);
      if (worker) {
        worker.bridge.abortAll();
        try {
          await worker.bot.api.deleteWebhook();
        } catch {}
      }
    }
    activeWorkers.clear();

    // Delete manager webhook
    try {
      await managerBot.api.deleteWebhook();
    } catch {}

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
