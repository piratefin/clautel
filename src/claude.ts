import { query } from "@anthropic-ai/claude-code";
import { config } from "./config.js";

const AUTO_APPROVE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
];

export interface SendCallbacks {
  onStreamChunk: (text: string) => void;
  onToolApproval: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<boolean>;
  onResult: (result: {
    text: string;
    costUsd: number;
    turns: number;
    durationMs: number;
  }) => void;
  onError: (error: Error) => void;
}

// chatId → Claude sessionId
const sessions = new Map<number, string>();
// chatId → total cost accumulated
const sessionCosts = new Map<number, number>();
// chatId → AbortController for active query
const activeAborts = new Map<number, AbortController>();

export function isProcessing(chatId: number): boolean {
  return activeAborts.has(chatId);
}

export function getSessionCost(chatId: number): number {
  return sessionCosts.get(chatId) || 0;
}

export function clearSession(chatId: number): void {
  sessions.delete(chatId);
  sessionCosts.delete(chatId);
}

export function cancelQuery(chatId: number): boolean {
  const controller = activeAborts.get(chatId);
  if (controller) {
    controller.abort();
    activeAborts.delete(chatId);
    return true;
  }
  return false;
}

export async function sendMessage(
  chatId: number,
  prompt: string,
  callbacks: SendCallbacks
): Promise<void> {
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  const sessionId = sessions.get(chatId);

  try {
    const q = query({
      prompt,
      options: {
        cwd: config.CLAUDE_WORKING_DIR,
        includePartialMessages: true,
        permissionMode: "default",
        ...(sessionId ? { resume: sessionId } : {}),
        abortController,
        canUseTool: async (toolName, input, { signal }) => {
          if (AUTO_APPROVE_TOOLS.includes(toolName)) {
            return { behavior: "allow" as const, updatedInput: input };
          }

          // Need user approval — race against abort signal
          const approved = await Promise.race([
            callbacks.onToolApproval(
              toolName,
              input as Record<string, unknown>
            ),
            new Promise<boolean>((resolve) => {
              if (signal.aborted) {
                resolve(false);
                return;
              }
              signal.addEventListener("abort", () => resolve(false), {
                once: true,
              });
            }),
          ]);

          if (approved) {
            return { behavior: "allow" as const, updatedInput: input };
          }
          return {
            behavior: "deny" as const,
            message: "User denied this action via Telegram",
          };
        },
      },
    });

    for await (const message of q) {
      if (abortController.signal.aborted) break;

      if (message.type === "system" && message.subtype === "init") {
        sessions.set(chatId, message.session_id);
      } else if (message.type === "stream_event") {
        const event = message.event as Record<string, unknown>;
        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            callbacks.onStreamChunk(delta.text);
          }
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          const cost = (message as Record<string, unknown>).total_cost_usd as number || 0;
          const prev = sessionCosts.get(chatId) || 0;
          sessionCosts.set(chatId, prev + cost);

          callbacks.onResult({
            text: (message as Record<string, unknown>).result as string || "",
            costUsd: cost,
            turns: (message as Record<string, unknown>).num_turns as number || 0,
            durationMs: (message as Record<string, unknown>).duration_ms as number || 0,
          });
        } else {
          const errors = (message as Record<string, unknown>).errors as string[] | undefined;
          callbacks.onError(
            new Error(errors?.join(", ") || "Claude query failed")
          );
        }
      }
    }
  } catch (error) {
    if (!abortController.signal.aborted) {
      callbacks.onError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  } finally {
    activeAborts.delete(chatId);
  }
}
