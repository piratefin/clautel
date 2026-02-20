import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  sendMessage,
  isProcessing,
  cancelQuery,
  clearSession,
  getSessionCost,
  setModel,
  getModel,
  AVAILABLE_MODELS,
} from "./claude.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
} from "./formatter.js";

// Pending approval promises: requestId → resolver
const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
>();

let approvalCounter = 0;

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Global error handler — don't crash on unhandled bot errors
  bot.catch((err) => {
    console.error("Bot error:", err.message);
  });

  // Owner-only guard
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.TELEGRAM_OWNER_ID) {
      await ctx.reply("Unauthorized.");
      return;
    }
    await next();
  });

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "<b>Claude on Phone</b>\n\n" +
        "Send any message to interact with Claude Code.\n\n" +
        "<b>Commands:</b>\n" +
        "/new - Start a fresh session\n" +
        "/model - Switch Claude model\n" +
        "/cost - Show session cost\n" +
        "/cancel - Abort current operation",
      { parse_mode: "HTML" }
    );
  });

  // /new command — fresh session
  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    if (isProcessing(chatId)) {
      cancelQuery(chatId);
    }
    clearSession(chatId);
    await ctx.reply("Session cleared. Send a message to start fresh.");
  });

  // /cost command
  bot.command("cost", async (ctx) => {
    const cost = getSessionCost(ctx.chat.id);
    await ctx.reply(`Session cost so far: $${cost.toFixed(4)}`);
  });

  // /model command — select Claude model
  bot.command("model", async (ctx) => {
    const current = getModel(ctx.chat.id);
    const currentLabel =
      AVAILABLE_MODELS.find((m) => m.id === current)?.label || current;

    const keyboard = new InlineKeyboard();
    for (const m of AVAILABLE_MODELS) {
      const check = m.id === current ? " (current)" : "";
      keyboard.text(`${m.label}${check}`, `model:${m.id}`).row();
    }

    await ctx.reply(`Current model: <b>${currentLabel}</b>\n\nSelect a model:`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  // /cancel command
  bot.command("cancel", async (ctx) => {
    if (cancelQuery(ctx.chat.id)) {
      await ctx.reply("Operation cancelled.");
    } else {
      await ctx.reply("Nothing running to cancel.");
    }
  });

  // Main message handler
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    if (isProcessing(chatId)) {
      await ctx.reply("Already processing a request. Use /cancel to abort.");
      return;
    }

    // Send placeholder
    const thinking = await ctx.reply("Thinking...");
    const thinkingMsgId = thinking.message_id;

    // Streaming state
    let buffer = "";
    let lastEditTime = 0;
    let editTimer: NodeJS.Timeout | null = null;
    let lastEditedText = "";

    const doEdit = async () => {
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
      lastEditTime = Date.now();

      let html = claudeToTelegram(buffer);
      if (html.length > 4000) {
        html = html.slice(0, 4000) + "\n\n<i>... streaming ...</i>";
      }

      if (!html.trim() || html === lastEditedText) return;
      lastEditedText = html;

      try {
        await bot.api.editMessageText(chatId, thinkingMsgId, html, {
          parse_mode: "HTML",
        });
      } catch {
        // Fallback to plain text if HTML fails
        try {
          const plain =
            buffer.length > 4000
              ? buffer.slice(0, 4000) + "\n\n... streaming ..."
              : buffer;
          if (plain.trim()) {
            await bot.api.editMessageText(chatId, thinkingMsgId, plain);
          }
        } catch {
          // Ignore edit errors (message not modified, etc.)
        }
      }
    };

    const onStreamChunk = (chunk: string) => {
      buffer += chunk;
      const now = Date.now();
      if (now - lastEditTime >= 1500) {
        doEdit();
      } else if (!editTimer) {
        editTimer = setTimeout(doEdit, 1500 - (now - lastEditTime));
      }
    };

    const onToolApproval = (
      toolName: string,
      input: Record<string, unknown>
    ): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const requestId = String(++approvalCounter);

        const timer = setTimeout(() => {
          pendingApprovals.delete(requestId);
          resolve(false);
        }, 5 * 60 * 1000); // 5 minute timeout

        pendingApprovals.set(requestId, { resolve, timer });

        const description = formatToolCall(toolName, input);
        const keyboard = new InlineKeyboard()
          .text("Approve", `approve:${requestId}`)
          .text("Deny", `deny:${requestId}`);

        bot.api
          .sendMessage(chatId, description, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          })
          .catch(() => {
            // If message send fails, auto-deny
            clearTimeout(timer);
            pendingApprovals.delete(requestId);
            resolve(false);
          });
      });
    };

    const onResult = async (result: {
      text: string;
      costUsd: number;
      turns: number;
      durationMs: number;
    }) => {
      if (editTimer) clearTimeout(editTimer);

      const html = claudeToTelegram(result.text);
      const parts = splitMessage(html);

      // Edit the thinking message with the first part
      try {
        await bot.api.editMessageText(
          chatId,
          thinkingMsgId,
          parts[0] || "Done.",
          { parse_mode: "HTML" }
        );
      } catch {
        try {
          await bot.api.editMessageText(
            chatId,
            thinkingMsgId,
            result.text.slice(0, 4096) || "Done."
          );
        } catch {
          // Ignore
        }
      }

      // Send remaining parts
      for (let i = 1; i < parts.length; i++) {
        try {
          await bot.api.sendMessage(chatId, parts[i], {
            parse_mode: "HTML",
          });
        } catch {
          await bot.api.sendMessage(
            chatId,
            result.text.slice(i * 4000, (i + 1) * 4000)
          ).catch(() => {});
        }
      }

      // Cost info
      const seconds = (result.durationMs / 1000).toFixed(1);
      await bot.api
        .sendMessage(
          chatId,
          `$${result.costUsd.toFixed(4)} | ${result.turns} turns | ${seconds}s`
        )
        .catch(() => {});
    };

    const onError = async (error: Error) => {
      if (editTimer) clearTimeout(editTimer);
      try {
        await bot.api.editMessageText(
          chatId,
          thinkingMsgId,
          `Error: ${error.message}`
        );
      } catch {
        await ctx.reply(`Error: ${error.message}`).catch(() => {});
      }
    };

    // Fire-and-forget: don't await, so the webhook responds to Telegram immediately.
    // Otherwise grammY's webhook adapter times out after 10s.
    sendMessage(chatId, text, {
      onStreamChunk,
      onToolApproval,
      onResult,
      onError,
    }).catch((err) => {
      onError(err instanceof Error ? err : new Error(String(err)));
    });
  });

  // Callback query handler for Approve/Deny buttons and model selection
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Model selection
    const modelMatch = data.match(/^model:(.+)$/);
    if (modelMatch) {
      const modelId = modelMatch[1];
      const chatId = ctx.chat!.id;
      const label =
        AVAILABLE_MODELS.find((m) => m.id === modelId)?.label || modelId;

      setModel(chatId, modelId);

      await ctx.editMessageText(
        `Model switched to <b>${label}</b>\nSession reset — next message uses the new model.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await ctx.answerCallbackQuery(`Switched to ${label}`).catch(() => {});
      return;
    }

    // Approve/Deny
    const match = data.match(/^(approve|deny):(\d+)$/);
    if (!match) {
      await ctx.answerCallbackQuery("Invalid action").catch(() => {});
      return;
    }

    const [, action, requestId] = match;
    const pending = pendingApprovals.get(requestId);

    if (!pending) {
      await ctx.answerCallbackQuery("Request expired").catch(() => {});
      return;
    }

    clearTimeout(pending.timer);
    pendingApprovals.delete(requestId);

    const approved = action === "approve";
    pending.resolve(approved);

    // Update the approval message
    const statusLabel = approved ? "APPROVED" : "DENIED";
    try {
      const originalText = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(`[${statusLabel}]\n${originalText}`);
    } catch {
      // Ignore edit errors
    }

    await ctx.answerCallbackQuery(approved ? "Approved" : "Denied").catch(() => {});
  });

  return bot;
}
