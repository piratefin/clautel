import ngrok from "@ngrok/ngrok";
import type { Bot } from "grammy";
import { config } from "./config.js";

let listener: ngrok.Listener | null = null;

export async function startTunnel(
  bot: Bot,
  port: number,
  webhookSecret: string
): Promise<string> {
  listener = await ngrok.connect({
    addr: port,
    authtoken: config.NGROK_AUTH_TOKEN,
  });

  const url = listener.url()!;
  console.log(`ngrok tunnel: ${url}`);

  await bot.api.setWebhook(`${url}/webhook`, {
    secret_token: webhookSecret,
  });
  console.log("Telegram webhook registered");

  return url;
}

export async function stopTunnel(): Promise<void> {
  if (listener) {
    await listener.close();
    listener = null;
    console.log("ngrok tunnel closed");
  }
}
