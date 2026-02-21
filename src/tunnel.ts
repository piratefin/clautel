import ngrok from "@ngrok/ngrok";
import { config } from "./config.js";

let listener: ngrok.Listener | null = null;

export async function startTunnel(port: number): Promise<string> {
  listener = await ngrok.connect({
    addr: port,
    authtoken: config.NGROK_AUTH_TOKEN,
  });

  const url = listener.url()!;
  console.log(`ngrok tunnel: ${url}`);
  return url;
}

export async function stopTunnel(): Promise<void> {
  if (listener) {
    await listener.close();
    listener = null;
    console.log("ngrok tunnel closed");
  }
}
