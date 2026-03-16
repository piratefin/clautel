import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface TopicMapping {
  threadId: number;
  name: string;
  workingDir: string;
  createdAt: string;
}

export interface ForumConfig {
  groupId: number;
  managerThreadId: number;
  allowedUsers: number[];
  adminUsers: number[];
  topics: TopicMapping[];
}

const FORUM_FILE = path.join(config.DATA_DIR, "forum.json");

function ensureDataDir(): void {
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
}

// In-memory cache to avoid disk I/O races and improve performance
let cachedConfig: ForumConfig | null = null;

const DEFAULT_CONFIG: ForumConfig = {
  groupId: 0,
  managerThreadId: 1,
  allowedUsers: [],
  adminUsers: [],
  topics: [],
};

export function loadForumConfig(): ForumConfig {
  if (cachedConfig) return cachedConfig;
  try {
    if (!fs.existsSync(FORUM_FILE)) {
      cachedConfig = { ...DEFAULT_CONFIG, topics: [] };
      return cachedConfig;
    }
    const raw = JSON.parse(fs.readFileSync(FORUM_FILE, "utf-8"));
    // Ensure adminUsers exists for configs saved before this field was added
    if (!Array.isArray(raw.adminUsers)) {
      raw.adminUsers = [];
    }
    cachedConfig = raw;
    return cachedConfig!;
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG, topics: [] };
    return cachedConfig;
  }
}

export function saveForumConfig(cfg: ForumConfig): void {
  ensureDataDir();
  cachedConfig = cfg;
  fs.writeFileSync(FORUM_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function addTopicMapping(topic: TopicMapping): void {
  const cfg = loadForumConfig();
  cfg.topics = cfg.topics.filter((t) => t.threadId !== topic.threadId);
  cfg.topics.push(topic);
  saveForumConfig(cfg);
}

export function removeTopicMapping(name: string): TopicMapping | null {
  const cfg = loadForumConfig();
  const idx = cfg.topics.findIndex((t) => t.name === name);
  if (idx === -1) return null;
  const [removed] = cfg.topics.splice(idx, 1);
  saveForumConfig(cfg);
  return removed;
}

export function getTopicMapping(threadId: number): TopicMapping | undefined {
  return loadForumConfig().topics.find((t) => t.threadId === threadId);
}

export function getAllowedUsers(): number[] {
  return loadForumConfig().allowedUsers;
}

export function setAllowedUsers(users: number[]): void {
  const cfg = loadForumConfig();
  cfg.allowedUsers = users;
  saveForumConfig(cfg);
}

export function getAdminUsers(): number[] {
  return loadForumConfig().adminUsers;
}

export function setAdminUsers(admins: number[]): void {
  const cfg = loadForumConfig();
  cfg.adminUsers = admins;
  saveForumConfig(cfg);
}

export function isAdmin(userId: number): boolean {
  return getAdminUsers().includes(userId);
}
