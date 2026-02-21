import path from "node:path";
import os from "node:os";
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  TELEGRAM_BOT_TOKEN: required("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_OWNER_ID: Number(required("TELEGRAM_OWNER_ID")),
  NGROK_AUTH_TOKEN: required("NGROK_AUTH_TOKEN"),
  DATA_DIR: path.join(os.homedir(), ".claude-on-phone"),
};
