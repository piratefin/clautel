import fs from "node:fs";
import { Bot } from "grammy";
import {
  loadForumConfig,
  saveForumConfig,
  addTopicMapping,
  removeTopicMapping,
  getAllowedUsers,
  setAllowedUsers,
  getAdminUsers,
  isAdmin,
} from "./forum-store.js";
import type { TopicMapping } from "./forum-store.js";
import { escapeHtml } from "./formatter.js";

export interface ForumManagerCallbacks {
  onTopicCreated: (topic: TopicMapping) => Promise<void>;
  onTopicRemoved: (topic: TopicMapping) => Promise<void>;
}

export function createForumManagerHandlers(
  bot: Bot,
  groupId: number,
  managerThreadId: number,
  callbacks: ForumManagerCallbacks,
) {
  const helpText =
    "<b>Forum Manager</b>\n\n" +
    "<b>Commands:</b>\n" +
    "/addtopic &lt;name&gt; &lt;/path/to/repo&gt; — Link a new project topic (admin)\n" +
    "/removetopic &lt;name&gt; — Remove a project topic (admin)\n" +
    "/topics — List linked project topics\n" +
    "/allowlist — View or manage authorized users (admin)\n" +
    "/help — Show this help message\n\n" +
    "<b>How it works:</b>\n" +
    "1. Use /addtopic to create a forum topic linked to a repo\n" +
    "2. Team members send messages in that topic to interact with Claude\n" +
    "3. Each topic has its own Claude session";

  function send(text: string, opts?: Record<string, unknown>) {
    const threadOpts = managerThreadId > 1 ? { message_thread_id: managerThreadId } : {};
    return bot.api.sendMessage(groupId, text, {
      ...opts,
      ...threadOpts,
    });
  }

  const ADMIN_COMMANDS = new Set(["addtopic", "removetopic", "allowlist"]);

  async function handleCommand(command: string, args: string, userId: number): Promise<void> {
    // Gate privileged commands behind admin check
    if (ADMIN_COMMANDS.has(command) && !isAdmin(userId)) {
      await send("⛔ This command requires admin privileges.", { parse_mode: "HTML" });
      return;
    }

    switch (command) {
      case "help":
      case "start":
        await send(helpText, { parse_mode: "HTML" });
        break;

      case "addtopic":
        await handleAddTopic(args);
        break;

      case "removetopic":
        await handleRemoveTopic(args);
        break;

      case "topics":
        await handleListTopics();
        break;

      case "allowlist":
        await handleAllowlist(args);
        break;
    }
  }

  async function handleAddTopic(args: string): Promise<void> {
    const spaceIdx = args.indexOf(" ");
    if (!args || spaceIdx === -1) {
      await send("Usage: <code>/addtopic name /path/to/repo</code>", { parse_mode: "HTML" });
      return;
    }

    const name = args.slice(0, spaceIdx).trim();
    const dir = args.slice(spaceIdx + 1).trim();

    if (!fs.existsSync(dir)) {
      await send(`Path does not exist: <code>${escapeHtml(dir)}</code>`, { parse_mode: "HTML" });
      return;
    }

    if (!fs.statSync(dir).isDirectory()) {
      await send(`Path is not a directory: <code>${escapeHtml(dir)}</code>`, { parse_mode: "HTML" });
      return;
    }

    // Check for duplicate name
    const cfg = loadForumConfig();
    if (cfg.topics.find((t) => t.name === name)) {
      await send(`Topic "${escapeHtml(name)}" already exists. Remove it first with /removetopic ${escapeHtml(name)}`, { parse_mode: "HTML" });
      return;
    }

    await send("Creating topic...");

    try {
      const result = await bot.api.createForumTopic(groupId, name);
      const topic: TopicMapping = {
        threadId: result.message_thread_id,
        name,
        workingDir: dir,
        createdAt: new Date().toISOString(),
      };

      addTopicMapping(topic);
      await callbacks.onTopicCreated(topic);

      await send(
        `Topic created: <b>${escapeHtml(name)}</b>\n` +
        `Repo: <code>${escapeHtml(dir)}</code>\n\n` +
        `Send messages in the "${escapeHtml(name)}" topic to interact with Claude.`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      await send(`Failed to create topic: ${(err as Error).message}`);
    }
  }

  async function handleRemoveTopic(args: string): Promise<void> {
    const name = args.trim();
    if (!name) {
      await send("Usage: <code>/removetopic name</code>", { parse_mode: "HTML" });
      return;
    }

    const removed = removeTopicMapping(name);
    if (!removed) {
      await send(`Topic "${escapeHtml(name)}" not found. Use /topics to see the list.`, { parse_mode: "HTML" });
      return;
    }

    await callbacks.onTopicRemoved(removed);
    await send(`Removed topic: <b>${escapeHtml(name)}</b>`, { parse_mode: "HTML" });
  }

  async function handleListTopics(): Promise<void> {
    const cfg = loadForumConfig();
    if (cfg.topics.length === 0) {
      await send("No project topics linked. Use /addtopic to add one.");
      return;
    }

    const lines = cfg.topics.map((t) =>
      `\u2022 <b>${escapeHtml(t.name)}</b> \u2014 <code>${escapeHtml(t.workingDir)}</code>`
    );
    await send(`<b>Linked topics (${cfg.topics.length}):</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
  }

  async function handleAllowlist(args: string): Promise<void> {
    const parts = args.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase();

    if (!action || (action !== "add" && action !== "remove")) {
      const users = getAllowedUsers();
      if (users.length === 0) {
        await send(
          "<b>Allowed users:</b> None\n\n" +
          "Usage:\n" +
          "<code>/allowlist add 123456789</code>\n" +
          "<code>/allowlist remove 123456789</code>",
          { parse_mode: "HTML" }
        );
      } else {
        await send(
          `<b>Allowed users (${users.length}):</b>\n` +
          users.map((u) => `\u2022 <code>${u}</code>`).join("\n") +
          "\n\nUsage:\n" +
          "<code>/allowlist add 123456789</code>\n" +
          "<code>/allowlist remove 123456789</code>",
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    const userId = Number(parts[1]);
    if (!userId || isNaN(userId)) {
      await send("Invalid user ID. Usage: <code>/allowlist add 123456789</code>", { parse_mode: "HTML" });
      return;
    }

    const users = getAllowedUsers();

    if (action === "add") {
      if (users.includes(userId)) {
        await send(`User <code>${userId}</code> is already in the allowlist.`, { parse_mode: "HTML" });
        return;
      }
      users.push(userId);
      setAllowedUsers(users);
      await send(`Added <code>${userId}</code> to allowlist.`, { parse_mode: "HTML" });
    } else {
      const filtered = users.filter((u) => u !== userId);
      if (filtered.length === users.length) {
        await send(`User <code>${userId}</code> not found in allowlist.`, { parse_mode: "HTML" });
        return;
      }
      // Prevent removing the last admin — would leave the bot unmanageable
      const admins = getAdminUsers();
      if (admins.includes(userId)) {
        const remainingAdminsOnAllowlist = filtered.filter((u) => admins.includes(u));
        if (remainingAdminsOnAllowlist.length === 0) {
          await send("⛔ Cannot remove the last admin from the allowlist.", { parse_mode: "HTML" });
          return;
        }
      }
      setAllowedUsers(filtered);
      await send(`Removed <code>${userId}</code> from allowlist.`, { parse_mode: "HTML" });
    }
  }

  return {
    handleCommand,
    helpText,
  };
}
