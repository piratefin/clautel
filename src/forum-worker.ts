import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { ClaudeBridge, AVAILABLE_MODELS } from "./claude.js";
import { TunnelManager, parsePort } from "./tunnel.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
  escapeHtml,
} from "./formatter.js";
import type { AskUserQuestion } from "./claude.js";
import { logUser, logStream, logResult, logError } from "./log.js";
import { checkLicenseForQuery, getPaymentUrl, detectClaudePlan } from "./license.js";
import { ScheduleManager, parseScheduleWithClaude, generateScheduleId } from "./scheduler.js";
import type { Schedule } from "./scheduler.js";
import { DATA_DIR } from "./config.js";
import { isAdmin } from "./forum-store.js";

const TYPING_INTERVAL_MS = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const APPROVAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const STREAM_MAX_LEN = 4000;
const REPLY_PREVIEW_MAX = 500;

interface QueueEntry {
  userId: number;
  username: string;
  prompt: string;
  resolve: () => void;
}

export interface ForumTopicContext {
  bridge: ClaudeBridge;
  tunnelManager: TunnelManager;
  threadId: number;
  name: string;
  workingDir: string;
}

export function createForumTopicHandlers(
  bot: Bot,
  topicCtx: ForumTopicContext,
  scheduleManager: ScheduleManager,
) {
  const { bridge, tunnelManager, threadId, name, workingDir } = topicCtx;
  const tag = `forum-${threadId}`;
  const repoName = path.basename(workingDir);
  // Session key: use threadId as chatId for shared session per topic
  const sessionKey = threadId;

  const pendingApprovals = new Map<
    string,
    { resolve: (result: "allow" | "always" | "deny") => void; timer: NodeJS.Timeout; description: string }
  >();
  const pendingPlanActions = new Map<
    string,
    { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
  >();
  const pendingAnswers = new Map<
    string,
    { resolve: (answer: string) => void; timer: NodeJS.Timeout; options: Array<{ label: string }>; question: string }
  >();
  const pendingFreeText = new Map<
    number,
    { resolve: (answer: string) => void; timer: NodeJS.Timeout; question: string; msgId: number }
  >();
  const pendingScheduleConfirm = new Map<number, { schedule: Omit<Schedule, "id" | "createdAt" | "lastRunAt">; timer: NodeJS.Timeout }>();
  let approvalCounter = 0;
  let retryCounter = 0;

  // Concurrency queue: one prompt at a time per topic
  let processing = false;
  const queue: QueueEntry[] = [];

  function cbPrefix(data: string): string {
    return `f${threadId}:${data}`;
  }

  async function sendToTopic(text: string, opts?: Record<string, unknown>): Promise<{ message_id: number }> {
    return bot.api.sendMessage(topicCtx.bridge.botId, text, {
      ...opts,
      message_thread_id: threadId,
    }) as Promise<{ message_id: number }>;
  }

  // Helper that sends using the group chat ID from the bot
  async function send(chatId: number, text: string, opts?: Record<string, unknown>): Promise<{ message_id: number }> {
    return bot.api.sendMessage(chatId, text, {
      ...opts,
      message_thread_id: threadId,
    }) as Promise<{ message_id: number }>;
  }

  const helpText =
    `<b>${escapeHtml(repoName)}</b> (Forum Topic)\n` +
    `<code>${escapeHtml(workingDir)}</code>\n\n` +
    "Send any message to interact with Claude Code.\n" +
    "All users in this topic share one session.\n\n" +
    "<b>Commands:</b>\n" +
    "/new — Start a fresh session (clears context)\n" +
    "/model — Switch Claude model\n" +
    "/cost — Show token usage\n" +
    "/session — Get session ID\n" +
    "/resume — Resume a CLI session\n" +
    "/cancel — Abort current operation\n" +
    "/preview [port] — Open live preview tunnel\n" +
    "/close — Close preview tunnel\n" +
    "/schedule — Add a scheduled task (admin)\n" +
    "/schedules — List scheduled tasks\n" +
    "/unschedule — Remove a scheduled task (admin)\n" +
    "/help — Show this help";

  const ADMIN_TOPIC_COMMANDS = new Set(["schedule", "unschedule"]);

  function handleCommand(chatId: number, command: string, args: string, userId: number, username: string) {
    if (ADMIN_TOPIC_COMMANDS.has(command) && !isAdmin(userId)) {
      send(chatId, "⛔ This command requires admin privileges.").catch(() => {});
      return;
    }

    switch (command) {
      case "help":
      case "start":
        send(chatId, helpText, { parse_mode: "HTML" }).catch(() => {});
        break;

      case "new":
        if (bridge.isProcessing(sessionKey)) {
          bridge.cancelQuery(sessionKey);
        }
        bridge.clearSession(sessionKey);
        send(chatId, "Session cleared. Send a message to start fresh.").catch(() => {});
        break;

      case "cost": {
        const t = bridge.getSessionTokens(sessionKey);
        const total = t.inputTokens + t.outputTokens;
        send(chatId,
          `<b>Session tokens</b>\n` +
          `Input: ${t.inputTokens.toLocaleString()}\n` +
          `Output: ${t.outputTokens.toLocaleString()}\n` +
          `Cache write: ${t.cacheCreationTokens.toLocaleString()}\n` +
          `Cache read: ${t.cacheReadTokens.toLocaleString()}\n` +
          `Total: ${total.toLocaleString()}`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        break;
      }

      case "model": {
        const current = bridge.getModel(sessionKey);
        const currentLabel = AVAILABLE_MODELS.find((m) => m.id === current)?.label || current;
        const keyboard = new InlineKeyboard();
        for (const m of AVAILABLE_MODELS) {
          const check = m.id === current ? " (current)" : "";
          keyboard.text(`${m.label}${check}`, cbPrefix(`model:${m.id}`)).row();
        }
        send(chatId, `Current model: <b>${currentLabel}</b>\n\nSelect a model:`, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }).catch(() => {});
        break;
      }

      case "cancel":
        if (bridge.cancelQuery(sessionKey)) {
          send(chatId, "Operation cancelled.").catch(() => {});
        } else {
          send(chatId, "Nothing running to cancel.").catch(() => {});
        }
        break;

      case "session": {
        const sid = bridge.getSessionId(sessionKey);
        if (!sid) {
          send(chatId, "No active session. Send a message first.").catch(() => {});
        } else {
          const cmd = `claude --resume ${sid}`;
          send(chatId,
            `<b>Session ID</b>\n<code>${sid}</code>\n\n` +
            `<b>Continue in CLI</b>\n` +
            `Run from <code>${escapeHtml(workingDir)}</code>:\n\n` +
            `<code>${cmd}</code>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        }
        break;
      }

      case "resume": {
        if (args) {
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(args)) {
            send(chatId, "Invalid session ID format.").catch(() => {});
            break;
          }
          const sessionFile = path.join(bridge.getProjectSessionsDir(), `${args}.jsonl`);
          if (!fs.existsSync(sessionFile)) {
            send(chatId, "Session file not found.").catch(() => {});
            break;
          }
          if (bridge.isProcessing(sessionKey)) bridge.cancelQuery(sessionKey);
          bridge.setSessionId(sessionKey, args);
          send(chatId, `Session resumed: <code>${args}</code>\n\nSend a message to continue.`, { parse_mode: "HTML" }).catch(() => {});
        } else {
          const sessions = bridge.listRecentSessions(8);
          if (sessions.length === 0) {
            send(chatId, "No CLI sessions found for this project.").catch(() => {});
            break;
          }
          const keyboard = new InlineKeyboard();
          for (const s of sessions) {
            const dateStr = s.modifiedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
              ", " + s.modifiedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
            const label = `${dateStr} — ${s.promptPreview}`;
            const truncatedLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
            keyboard.text(truncatedLabel, cbPrefix(`resume:${s.sessionId}`)).row();
          }
          send(chatId, "Select a session to resume:", { reply_markup: keyboard }).catch(() => {});
        }
        break;
      }

      case "schedule":
        handleScheduleCommand(chatId, args, userId).catch(() => {});
        break;

      case "schedules":
        handleSchedulesCommand(chatId).catch(() => {});
        break;

      case "unschedule":
        handleUnscheduleCommand(chatId, args).catch(() => {});
        break;

      case "preview":
        handlePreviewCommand(chatId, args).catch(() => {});
        break;

      case "close": {
        tunnelManager.closeTunnel(sessionKey).then((closed) => {
          send(chatId, closed ? "Preview tunnel closed." : "No active preview.").catch(() => {});
        }).catch(() => {});
        break;
      }
    }
  }

  async function handleScheduleCommand(chatId: number, input: string, userId: number): Promise<void> {
    if (!input) {
      await send(chatId,
        "<b>Schedule a recurring task</b>\n\n" +
        "Example:\n" +
        "<code>/schedule daily 9am run tests</code>",
        { parse_mode: "HTML" }
      );
      return;
    }
    await send(chatId, "Parsing schedule...");
    const parsed = await parseScheduleWithClaude(input);
    if (!parsed) {
      await send(chatId, "Could not parse schedule. Try being more specific.", { parse_mode: "HTML" });
      return;
    }
    const timer = setTimeout(() => { pendingScheduleConfirm.delete(threadId); }, 5 * 60 * 1000);
    pendingScheduleConfirm.set(threadId, {
      schedule: { botId: bridge.botId, chatId, prompt: parsed.prompt, cronExpr: parsed.cronExpr, humanLabel: parsed.humanLabel },
      timer,
    });
    const keyboard = new InlineKeyboard()
      .text("Confirm", cbPrefix(`schedule:confirm:${threadId}`))
      .text("Cancel", cbPrefix(`schedule:cancel:${threadId}`));
    await send(chatId,
      "<b>Confirm schedule</b>\n\n" +
      `<b>When:</b> ${escapeHtml(parsed.humanLabel)}\n` +
      `<b>Task:</b> ${escapeHtml(parsed.prompt)}\n\n` +
      "<i>Scheduled tasks run automatically without approval prompts.</i>",
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  }

  async function handleSchedulesCommand(chatId: number): Promise<void> {
    const schedules = scheduleManager.getForBot(bridge.botId);
    if (schedules.length === 0) {
      await send(chatId, "No scheduled tasks. Use /schedule to add one.");
      return;
    }
    const lines = schedules.map((s, i) => {
      const lastRun = s.lastRunAt ? `Last run: ${new Date(s.lastRunAt).toLocaleString()}` : "Never run";
      return `<b>[${i + 1}]</b> ${escapeHtml(s.humanLabel)}\n${escapeHtml(s.prompt)}\n<i>${lastRun}</i>`;
    });
    await send(chatId,
      `<b>Scheduled tasks for ${escapeHtml(repoName)}</b>\n\n` + lines.join("\n\n") +
      "\n\nUse /unschedule &lt;number&gt; to remove.",
      { parse_mode: "HTML" }
    );
  }

  async function handleUnscheduleCommand(chatId: number, arg: string): Promise<void> {
    if (!arg) {
      await send(chatId, "Usage: <code>/unschedule &lt;number&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    const schedules = scheduleManager.getForBot(bridge.botId);
    const idx = parseInt(arg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= schedules.length) {
      await send(chatId, "Invalid number. Use /schedules to see the list.");
      return;
    }
    const schedule = schedules[idx];
    scheduleManager.remove(schedule.id);
    await send(chatId, `Removed: <b>${escapeHtml(schedule.humanLabel)}</b>`, { parse_mode: "HTML" });
  }

  async function handlePreviewCommand(chatId: number, arg: string): Promise<void> {
    if (arg) {
      const port = parsePort(arg);
      if (!port) {
        await send(chatId, "Invalid port. Example: /preview 3000");
        return;
      }
      try {
        const url = await tunnelManager.openTunnel(sessionKey, port);
        const keyboard = new InlineKeyboard().text("Close Preview", cbPrefix(`tunnel:close:${sessionKey}`));
        await send(chatId, `Live preview: ${url}\n\nPort ${port}.`, { reply_markup: keyboard });
      } catch (err) {
        await send(chatId, `Tunnel error: ${(err as Error).message}`);
      }
    } else {
      await send(chatId, "Usage: <code>/preview &lt;port&gt;</code>", { parse_mode: "HTML" });
    }
  }

  function handlePrompt(chatId: number, prompt: string, userId: number, username: string) {
    const entry: QueueEntry = {
      userId,
      username,
      prompt,
      resolve: () => {},
    };

    if (processing) {
      const pos = queue.length + 1;
      send(chatId, `Processing a request from another user. Yours is queued (#${pos})...`).catch(() => {});
      queue.push(entry);
      return;
    }

    processPrompt(chatId, prompt, userId, username);
  }

  function processPrompt(chatId: number, prompt: string, userId: number, username: string) {
    processing = true;

    (async () => {
      const licenseCheck = checkLicenseForQuery();
      if (!licenseCheck.allowed) {
        const reason = licenseCheck.reason || `License required.\n\nGet a license: ${getPaymentUrl(detectClaudePlan().tier)}`;
        await send(chatId, reason);
        return;
      }
      if (licenseCheck.warning) {
        await send(chatId, licenseCheck.warning);
      }

      if (bridge.isProcessing(sessionKey)) {
        await send(chatId, "Claude is busy. Use /cancel to stop it first.");
        return;
      }

      if (bridge.isCoolingDown(sessionKey)) {
        await send(chatId, "Slow down — wait a moment.");
        return;
      }

      bridge.setLastPrompt(sessionKey, prompt);

      await bot.api.sendChatAction(chatId, "typing").catch(() => {});

      // No draft in forum — always use editMessageText
      const thinking = await send(chatId, "Thinking...");
      let thinkingMsgId = thinking.message_id;

      const typingInterval = setInterval(() => {
        bot.api.sendChatAction(chatId, "typing").catch(() => {});
      }, TYPING_INTERVAL_MS);

      let buffer = "";
      let currentActivity = "Thinking...";
      let lastEditTime = 0;
      let editTimer: NodeJS.Timeout | null = null;
      let lastEditedText = "";

      const doEdit = async () => {
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        lastEditTime = Date.now();

        const htmlFooter = currentActivity ? `\n\n<i>${escapeHtml(currentActivity)}</i>` : "";
        let htmlContent: string;
        if (buffer.trim()) {
          let html = claudeToTelegram(buffer);
          const maxLen = STREAM_MAX_LEN - htmlFooter.length;
          if (html.length > maxLen) {
            html = html.slice(0, maxLen) + "\n\n<i>... streaming ...</i>";
          }
          htmlContent = html + htmlFooter;
        } else {
          htmlContent = htmlFooter.trim() || "<i>Thinking...</i>";
        }

        if (!htmlContent.trim() || htmlContent === lastEditedText) return;
        lastEditedText = htmlContent;

        if (!thinkingMsgId) return;
        try {
          await bot.api.editMessageText(chatId, thinkingMsgId, htmlContent, {
            parse_mode: "HTML",
            message_thread_id: threadId,
          } as Record<string, unknown>);
        } catch {
          // Fall back to plain text
          const plain = buffer.trim() ? buffer.slice(0, STREAM_MAX_LEN) : (currentActivity || "Thinking...");
          try {
            await bot.api.editMessageText(chatId, thinkingMsgId, plain, {
              message_thread_id: threadId,
            } as Record<string, unknown>);
          } catch {}
        }
      };

      const scheduleEdit = () => {
        const now = Date.now();
        if (now - lastEditTime >= EDIT_DEBOUNCE_MS) {
          doEdit();
        } else if (!editTimer) {
          editTimer = setTimeout(doEdit, EDIT_DEBOUNCE_MS - (now - lastEditTime));
        }
      };

      const onStatusUpdate = (status: string) => {
        currentActivity = status;
        scheduleEdit();
      };

      const onStreamChunk = (chunk: string) => {
        buffer += chunk;
        currentActivity = "";
        scheduleEdit();
      };

      const onPlanApproval = async (planFileContent?: string): Promise<boolean> => {
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        const preamble = buffer.trim();
        buffer = "";
        currentActivity = "";
        await doEdit();

        const planBody = planFileContent?.trim() ?? "";
        const fullPlan = planBody || preamble;

        if (fullPlan) {
          const html = claudeToTelegram(fullPlan);
          const parts = splitMessage(html);
          for (const part of parts) {
            try {
              await send(chatId, part, { parse_mode: "HTML" });
            } catch {
              await send(chatId, part).catch(() => {});
            }
          }
        }

        currentActivity = "Waiting for plan approval...";
        const requestId = String(++approvalCounter);
        const keyboard = new InlineKeyboard()
          .text("Approve Plan", cbPrefix(`plan:approve:${requestId}`))
          .row()
          .text("Reject Plan", cbPrefix(`plan:reject:${requestId}`));

        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            pendingPlanActions.delete(requestId);
            resolve(false);
          }, APPROVAL_TIMEOUT_MS);
          pendingPlanActions.set(requestId, { resolve, timer });
          send(chatId, "<b>Approve this plan?</b>", {
            parse_mode: "HTML",
            reply_markup: keyboard,
          }).catch(() => {
            clearTimeout(timer);
            pendingPlanActions.delete(requestId);
            resolve(false);
          });
        });
      };

      const onAskUser = async (questions: AskUserQuestion[]): Promise<Record<string, string>> => {
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }

        const answers: Record<string, string> = {};
        for (const q of questions) {
          const requestId = String(++approvalCounter);
          const keyboard = new InlineKeyboard();
          q.options.forEach((opt, optIdx) => {
            keyboard.text(opt.label, cbPrefix(`answer:${requestId}:${optIdx}`));
            keyboard.row();
          });
          keyboard.text("Other\u2026", cbPrefix(`answer:${requestId}:other`));

          const answer = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              pendingAnswers.delete(requestId);
              resolve(q.options[0]?.label || "");
            }, APPROVAL_TIMEOUT_MS);
            pendingAnswers.set(requestId, { resolve, timer, options: q.options, question: q.question });
            const desc = q.options.map((o) => `\u2022 <b>${escapeHtml(o.label)}</b> \u2014 ${escapeHtml(o.description)}`).join("\n");
            send(chatId,
              `<b>${escapeHtml(q.header)}</b>\n${escapeHtml(q.question)}\n\n${desc}`,
              { parse_mode: "HTML", reply_markup: keyboard }
            ).catch(() => {
              clearTimeout(timer);
              pendingAnswers.delete(requestId);
              resolve(q.options[0]?.label || "");
            });
          });
          answers[q.question] = answer;
        }
        return answers;
      };

      const onToolApproval = async (
        toolName: string,
        input: Record<string, unknown>
      ): Promise<"allow" | "always" | "deny"> => {
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }

        return new Promise<"allow" | "always" | "deny">((resolve) => {
          const requestId = String(++approvalCounter);
          const timer = setTimeout(() => {
            pendingApprovals.delete(requestId);
            resolve("deny");
          }, APPROVAL_TIMEOUT_MS);
          const description = formatToolCall(toolName, input);
          pendingApprovals.set(requestId, { resolve, timer, description });
          const keyboard = new InlineKeyboard()
            .text("Approve", cbPrefix(`approve:${requestId}`))
            .text("Always Allow", cbPrefix(`alwaysallow:${requestId}`))
            .row()
            .text("Deny", cbPrefix(`deny:${requestId}`));
          send(chatId, description, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          }).catch(() => {
            clearTimeout(timer);
            pendingApprovals.delete(requestId);
            resolve("deny");
          });
        });
      };

      let responseHandled = false;

      const onResult = async (result: {
        text: string;
        usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
        turns: number;
        durationMs: number;
      }) => {
        responseHandled = true;
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);

        const finalText = buffer || result.text || "Done.";
        logStream(finalText, tag);

        const html = claudeToTelegram(finalText);
        const parts = splitMessage(html);

        if (thinkingMsgId) {
          try {
            await bot.api.deleteMessage(chatId, thinkingMsgId);
          } catch {
            try {
              await bot.api.editMessageText(chatId, thinkingMsgId, "\u23E4", {
                message_thread_id: threadId,
              } as Record<string, unknown>);
            } catch {}
          }
        }

        for (const part of parts) {
          try {
            await send(chatId, part || "Done.", { parse_mode: "HTML" });
          } catch {
            await send(chatId, part || "Done.").catch(() => {});
          }
        }

        const seconds = (result.durationMs / 1000).toFixed(1);
        const tokens = result.usage.inputTokens + result.usage.outputTokens;
        logResult(tokens, result.turns, seconds, tag);
        await send(chatId, `${tokens.toLocaleString()} tokens | ${result.turns} turns | ${seconds}s`).catch(() => {});
      };

      const onError = async (error: Error) => {
        responseHandled = true;
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);
        logError(error.message, tag);

        const retryId = String(++retryCounter);
        const keyboard = new InlineKeyboard().text("Retry", cbPrefix(`retry:${retryId}`));

        if (thinkingMsgId) {
          try {
            await bot.api.editMessageText(
              chatId,
              thinkingMsgId,
              `Error: ${error.message}`,
              { reply_markup: keyboard, message_thread_id: threadId } as Record<string, unknown>
            );
          } catch {
            await send(chatId, `Error: ${error.message}`, { reply_markup: keyboard }).catch(() => {});
          }
        } else {
          await send(chatId, `Error: ${error.message}`, { reply_markup: keyboard }).catch(() => {});
        }
      };

      await bridge.sendMessage(sessionKey, prompt, {
        onStreamChunk,
        onStatusUpdate,
        onToolApproval,
        onAskUser,
        onPlanApproval,
        onResult,
        onError,
        onSessionReset: () => {
          send(chatId, "Previous session not found. Starting a fresh session.").catch(() => {});
        },
      });

      if (!responseHandled) {
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);
        if (thinkingMsgId) {
          try {
            await bot.api.deleteMessage(chatId, thinkingMsgId);
          } catch {
            try {
              await bot.api.editMessageText(chatId, thinkingMsgId, "Cancelled.", {
                message_thread_id: threadId,
              } as Record<string, unknown>);
            } catch {}
          }
        }
      }
    })().catch((err) => {
      console.error(`[${tag}] handlePrompt error:`, err);
    }).finally(() => {
      processing = false;
      processNext(chatId);
    });
  }

  function processNext(chatId: number) {
    const next = queue.shift();
    if (next) {
      processPrompt(chatId, next.prompt, next.userId, next.username);
    }
  }

  function extractReplyContext(msg: { reply_to_message?: { text?: string } }): string {
    const quoted = msg.reply_to_message?.text;
    if (!quoted) return "";
    const preview = quoted.length > REPLY_PREVIEW_MAX ? quoted.slice(0, REPLY_PREVIEW_MAX) + "..." : quoted;
    return `[Replying to message: "${preview}"]\n\n`;
  }

  // Handle callback queries with our prefix.
  // Note: callback buttons are intentionally NOT user-gated. All allowed users in a topic
  // share one Claude session, so any user can interact with any approval/plan/answer button.
  // This is consistent with the shared-session model described in helpText.
  function handleCallback(chatId: number, data: string, ctx: { answerCallbackQuery: (text?: string) => Promise<unknown>; editMessageText: (text: string, opts?: Record<string, unknown>) => Promise<unknown> }): boolean {
    // Schedule confirm/cancel
    if (data.startsWith("schedule:confirm:") || data.startsWith("schedule:cancel:")) {
      const parts = data.split(":");
      const action = parts[1];
      const tid = Number(parts[2]);
      const pending = pendingScheduleConfirm.get(tid);
      if (!pending) {
        ctx.answerCallbackQuery("Confirmation expired").catch(() => {});
        return true;
      }
      clearTimeout(pending.timer);
      pendingScheduleConfirm.delete(tid);
      if (action === "cancel") {
        ctx.editMessageText("Schedule cancelled.").catch(() => {});
        ctx.answerCallbackQuery("Cancelled").catch(() => {});
        return true;
      }
      const schedule: Schedule = {
        ...pending.schedule,
        id: generateScheduleId(),
        createdAt: new Date().toISOString(),
        lastRunAt: null,
      };
      scheduleManager.add(schedule);
      ctx.editMessageText(
        `<b>Schedule saved</b>\n\n` +
        `<b>When:</b> ${escapeHtml(schedule.humanLabel)}\n` +
        `<b>Task:</b> ${escapeHtml(schedule.prompt)}\n\n` +
        `Use /schedules to view or /unschedule to remove.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      ctx.answerCallbackQuery("Schedule saved").catch(() => {});
      return true;
    }

    // Tunnel close
    if (data.startsWith("tunnel:close:")) {
      const key = Number(data.split(":")[2]);
      ctx.answerCallbackQuery().catch(() => {});
      tunnelManager.closeTunnel(key).then((closed) => {
        ctx.editMessageText(closed ? "Preview tunnel closed." : "No active preview.").catch(() => {});
      });
      return true;
    }

    // Model selection
    const modelMatch = data.match(/^model:(.+)$/);
    if (modelMatch) {
      const modelId = modelMatch[1];
      const label = AVAILABLE_MODELS.find((m) => m.id === modelId)?.label || modelId;
      bridge.setModel(sessionKey, modelId);
      ctx.editMessageText(`Model switched to <b>${label}</b>\nSession reset.`, { parse_mode: "HTML" }).catch(() => {});
      ctx.answerCallbackQuery(`Switched to ${label}`).catch(() => {});
      return true;
    }

    // Resume session
    const resumeMatch = data.match(/^resume:(.+)$/);
    if (resumeMatch) {
      const sid = resumeMatch[1];
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(sid)) {
        ctx.answerCallbackQuery("Invalid session ID").catch(() => {});
        return true;
      }
      if (bridge.isProcessing(sessionKey)) bridge.cancelQuery(sessionKey);
      bridge.setSessionId(sessionKey, sid);
      ctx.editMessageText(`Session resumed: <code>${sid}</code>\n\nSend a message to continue.`, { parse_mode: "HTML" }).catch(() => {});
      ctx.answerCallbackQuery("Session resumed").catch(() => {});
      return true;
    }

    // Plan approval
    if (data.startsWith("plan:")) {
      const parts = data.split(":");
      const action = parts[1];
      const requestId = parts[2];
      const pending = pendingPlanActions.get(requestId);
      if (!pending) {
        ctx.answerCallbackQuery("Request expired").catch(() => {});
        return true;
      }
      clearTimeout(pending.timer);
      pendingPlanActions.delete(requestId);
      const approved = action === "approve";
      pending.resolve(approved);
      ctx.editMessageText(approved ? "Plan approved." : "Plan rejected.").catch(() => {});
      ctx.answerCallbackQuery(approved ? "Plan approved" : "Plan rejected").catch(() => {});
      return true;
    }

    // Question answer
    if (data.startsWith("answer:")) {
      const parts = data.split(":");
      const requestId = parts[1];
      const optPart = parts[2];
      const pending = pendingAnswers.get(requestId);
      if (!pending) {
        ctx.answerCallbackQuery("Request expired").catch(() => {});
        return true;
      }
      if (optPart === "other") {
        clearTimeout(pending.timer);
        pendingAnswers.delete(requestId);
        ctx.answerCallbackQuery("Type your answer").catch(() => {});
        ctx.editMessageText(`<b>${escapeHtml(pending.question)}</b>\n\nType your answer:`, { parse_mode: "HTML" }).catch(() => {});
        send(chatId, "Send your reply now\u2026").then((sentMsg) => {
          const timer = setTimeout(() => {
            pendingFreeText.delete(threadId);
            bot.api.editMessageText(chatId, sentMsg.message_id, "Timed out waiting for answer.", {
              message_thread_id: threadId,
            } as Record<string, unknown>).catch(() => {});
            pending.resolve("");
          }, APPROVAL_TIMEOUT_MS);
          pendingFreeText.set(threadId, { resolve: pending.resolve, timer, question: pending.question, msgId: sentMsg.message_id });
        }).catch(() => {
          pending.resolve("");
        });
        return true;
      }
      const optIdx = Number(optPart);
      clearTimeout(pending.timer);
      pendingAnswers.delete(requestId);
      const selectedLabel = pending.options[optIdx]?.label || "";
      pending.resolve(selectedLabel);
      ctx.editMessageText(`<b>${escapeHtml(pending.question)}</b>\n\nSelected: <b>${escapeHtml(selectedLabel)}</b>`, { parse_mode: "HTML" }).catch(() => {});
      ctx.answerCallbackQuery(`Selected: ${selectedLabel}`).catch(() => {});
      return true;
    }

    // Retry
    if (data.startsWith("retry:")) {
      const lastPrompt = bridge.getLastPrompt(sessionKey);
      if (!lastPrompt) {
        ctx.answerCallbackQuery("No previous prompt to retry.").catch(() => {});
        return true;
      }
      ctx.editMessageText("Retrying...").catch(() => {});
      ctx.answerCallbackQuery("Retrying").catch(() => {});
      processPrompt(chatId, lastPrompt, 0, "");
      return true;
    }

    // Tool approval
    const match = data.match(/^(approve|alwaysallow|deny):(\d+)$/);
    if (match) {
      const [, action, requestId] = match;
      const pending = pendingApprovals.get(requestId);
      if (!pending) {
        ctx.answerCallbackQuery("Request expired").catch(() => {});
        return true;
      }
      clearTimeout(pending.timer);
      pendingApprovals.delete(requestId);
      const result: "allow" | "always" | "deny" =
        action === "approve" ? "allow" :
        action === "alwaysallow" ? "always" : "deny";
      pending.resolve(result);
      const statusLabel =
        result === "allow" ? "APPROVED" :
        result === "always" ? "ALWAYS ALLOWED" : "DENIED";
      ctx.editMessageText(`[${statusLabel}]\n${pending.description}`, { parse_mode: "HTML" }).catch(() => {});
      const answerText =
        result === "allow" ? "Approved" :
        result === "always" ? "Allowed for this session" : "Denied";
      ctx.answerCallbackQuery(answerText).catch(() => {});
      return true;
    }

    return false;
  }

  function handleFreeText(chatId: number, text: string): boolean {
    const freeText = pendingFreeText.get(threadId);
    if (!freeText) return false;
    clearTimeout(freeText.timer);
    pendingFreeText.delete(threadId);
    bot.api.editMessageText(chatId, freeText.msgId,
      `<b>${escapeHtml(freeText.question)}</b>\n\nAnswer: <b>${escapeHtml(text)}</b>`,
      { parse_mode: "HTML", message_thread_id: threadId } as Record<string, unknown>
    ).catch(() => {});
    freeText.resolve(text);
    return true;
  }

  return {
    handleCommand,
    handlePrompt,
    handleCallback,
    handleFreeText,
    extractReplyContext,
    helpText,
  };
}
