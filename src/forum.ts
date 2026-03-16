import { Bot } from "grammy";
import { ClaudeBridge } from "./claude.js";
import { TunnelManager } from "./tunnel.js";
import { config } from "./config.js";
import { ScheduleManager } from "./scheduler.js";
import {
  loadForumConfig,
  saveForumConfig,
  getAllowedUsers,
  getTopicMapping,
  isAdmin,
} from "./forum-store.js";
import type { TopicMapping } from "./forum-store.js";
import { createForumManagerHandlers } from "./forum-manager.js";
import { createForumTopicHandlers } from "./forum-worker.js";
import { logUser } from "./log.js";

interface TopicState {
  bridge: ClaudeBridge;
  tunnelManager: TunnelManager;
  handlers: ReturnType<typeof createForumTopicHandlers>;
}

export function createForumBot(
  cfg: typeof config,
  scheduleManager: ScheduleManager,
): Bot {
  const bot = new Bot(cfg.FORUM_BOT_TOKEN!);
  const groupId = cfg.FORUM_GROUP_ID!;
  const managerThreadId = cfg.FORUM_MANAGER_THREAD_ID || 1;

  const topicStates = new Map<number, TopicState>();

  // Initialize persisted forum config with runtime values
  const forumCfg = loadForumConfig();
  forumCfg.groupId = groupId;
  forumCfg.managerThreadId = managerThreadId;
  // Merge initial allowlist from config if forum.json has none
  if (forumCfg.allowedUsers.length === 0 && cfg.FORUM_ALLOWED_USERS.length > 0) {
    forumCfg.allowedUsers = [...cfg.FORUM_ALLOWED_USERS];
  }
  // Initialize admin users: seed from config or fall back to TELEGRAM_OWNER_ID
  if (forumCfg.adminUsers.length === 0) {
    const seedAdmins = cfg.FORUM_ADMIN_USERS.length > 0
      ? [...cfg.FORUM_ADMIN_USERS]
      : [cfg.TELEGRAM_OWNER_ID];
    forumCfg.adminUsers = seedAdmins;
    // Ensure admins are also on the allowlist
    for (const admin of seedAdmins) {
      if (!forumCfg.allowedUsers.includes(admin)) {
        forumCfg.allowedUsers.push(admin);
      }
    }
  }
  saveForumConfig(forumCfg);

  bot.catch((err) => {
    console.error("[forum] Bot error:", err.message);
  });

  // Boot existing topic mappings
  function bootTopic(topic: TopicMapping): void {
    if (topicStates.has(topic.threadId)) return;

    const bridge = new ClaudeBridge(
      // Use a unique numeric ID derived from threadId to avoid collisions with DM bot IDs
      // Prefix with a large number to avoid collision
      900_000_000 + topic.threadId,
      topic.workingDir,
      `forum-${topic.name}`,
    );
    const tunnelManager = new TunnelManager(cfg.NGROK_AUTH_TOKEN);
    const handlers = createForumTopicHandlers(bot, {
      bridge,
      tunnelManager,
      threadId: topic.threadId,
      name: topic.name,
      workingDir: topic.workingDir,
    }, scheduleManager);

    topicStates.set(topic.threadId, { bridge, tunnelManager, handlers });
    console.log(`[forum] Topic booted: ${topic.name} (thread ${topic.threadId}) → ${topic.workingDir}`);
  }

  function teardownTopic(threadId: number): void {
    const state = topicStates.get(threadId);
    if (!state) return;
    state.bridge.abortAll();
    state.tunnelManager.closeAll().catch(() => {});
    topicStates.delete(threadId);
  }

  // Boot all saved topics
  for (const topic of forumCfg.topics) {
    bootTopic(topic);
  }

  // Manager handlers
  const managerHandlers = createForumManagerHandlers(bot, groupId, managerThreadId, {
    onTopicCreated: async (topic) => {
      bootTopic(topic);
    },
    onTopicRemoved: async (topic) => {
      teardownTopic(topic.threadId);
    },
  });

  // Auth middleware: check group + allowlist
  bot.use(async (ctx, next) => {
    // Only handle messages/callbacks from our target group
    if (ctx.chat?.id !== groupId) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    // Check allowlist — when empty, only admins can interact (not open access)
    const allowed = getAllowedUsers();
    if (allowed.length > 0) {
      if (!allowed.includes(userId)) {
        return; // Silently ignore unauthorized users
      }
    } else {
      // Empty allowlist: fall back to admin-only access
      if (!isAdmin(userId)) {
        return;
      }
    }

    await next();
  });

  // Command routing
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const threadId = ctx.message.message_thread_id;
    const userId = ctx.from?.id ?? 0;
    const username = ctx.from?.username || ctx.from?.first_name || String(userId);

    // Determine if this is a command
    const cmdMatch = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)/s);

    // Route to manager topic
    if (!threadId || threadId === managerThreadId) {
      if (cmdMatch) {
        managerHandlers.handleCommand(cmdMatch[1], cmdMatch[2].trim(), userId);
      }
      // Non-command messages in manager topic are ignored
      return;
    }

    // Route to project topic
    const state = topicStates.get(threadId);
    if (!state) {
      // Unknown topic — ignore
      return;
    }

    if (cmdMatch) {
      const command = cmdMatch[1];
      const args = cmdMatch[2].trim();
      state.handlers.handleCommand(ctx.chat.id, command, args, userId, username);
      return;
    }

    // Check for pending free text answers first
    if (state.handlers.handleFreeText(ctx.chat.id, text)) return;

    // Regular message — route to handlePrompt
    const replyCtx = state.handlers.extractReplyContext(ctx.message);
    const prompt = replyCtx + text;
    logUser(`[forum/${state.handlers.helpText ? topicStates.get(threadId)?.bridge.workingDir : threadId}] ${text}`, `forum-${threadId}`);
    state.handlers.handlePrompt(ctx.chat.id, prompt, userId, username);
  });

  // Callback query routing: parse f{threadId}: prefix
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Check for forum callback prefix
    const prefixMatch = data.match(/^f(\d+):(.+)$/);
    if (!prefixMatch) {
      await ctx.answerCallbackQuery("Invalid action").catch(() => {});
      return;
    }

    const threadId = Number(prefixMatch[1]);
    const innerData = prefixMatch[2];

    const state = topicStates.get(threadId);
    if (!state) {
      await ctx.answerCallbackQuery("Topic not found").catch(() => {});
      return;
    }

    const handled = state.handlers.handleCallback(chatId, innerData, {
      answerCallbackQuery: (text?: string) => ctx.answerCallbackQuery(text),
      editMessageText: (text: string, opts?: Record<string, unknown>) =>
        ctx.editMessageText(text, opts),
    });

    if (!handled) {
      await ctx.answerCallbackQuery("Unknown action").catch(() => {});
    }
  });

  return bot;
}
