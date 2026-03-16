import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import "dotenv/config";

export const DATA_DIR = path.join(os.homedir(), ".clautel");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

interface SavedConfig {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_ID?: number;
  NGROK_AUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  FORUM_BOT_TOKEN?: string;
  FORUM_GROUP_ID?: number;
  FORUM_MANAGER_THREAD_ID?: number;
  FORUM_ALLOWED_USERS?: number[];
  FORUM_ADMIN_USERS?: number[];
}

function loadSavedConfig(): SavedConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function required(name: string, savedValue?: string | number): string {
  const value = process.env[name] ?? (savedValue !== undefined ? String(savedValue) : undefined);
  if (!value) {
    console.error(`Missing required config: ${name}`);
    console.error("Run: clautel setup");
    process.exit(1);
  }
  return value;
}

function parseNumberList(envVar?: string, savedList?: number[]): number[] {
  if (envVar) {
    return envVar.split(",").map(Number).filter((n) => !isNaN(n) && n > 0);
  }
  return (savedList || []) as number[];
}

const saved = loadSavedConfig();

// Make ANTHROPIC_API_KEY available from config file as fallback for launchd (no env secrets in plist)
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? saved.ANTHROPIC_API_KEY;
if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;

export const config = {
  TELEGRAM_BOT_TOKEN: required("TELEGRAM_BOT_TOKEN", saved.TELEGRAM_BOT_TOKEN),
  TELEGRAM_OWNER_ID: Number(required("TELEGRAM_OWNER_ID", saved.TELEGRAM_OWNER_ID)),
  NGROK_AUTH_TOKEN: process.env.NGROK_AUTH_TOKEN ?? saved.NGROK_AUTH_TOKEN ?? undefined,
  ANTHROPIC_API_KEY: anthropicKey,
  DATA_DIR,
  FORUM_BOT_TOKEN: process.env.FORUM_BOT_TOKEN ?? saved.FORUM_BOT_TOKEN ?? undefined,
  FORUM_GROUP_ID: Number(process.env.FORUM_GROUP_ID ?? saved.FORUM_GROUP_ID ?? 0) || undefined,
  FORUM_MANAGER_THREAD_ID: Number(process.env.FORUM_MANAGER_THREAD_ID ?? saved.FORUM_MANAGER_THREAD_ID ?? 1) || 1,
  FORUM_ALLOWED_USERS: (saved.FORUM_ALLOWED_USERS || []) as number[],
  FORUM_ADMIN_USERS: parseNumberList(process.env.FORUM_ADMIN_USERS, saved.FORUM_ADMIN_USERS),
};
