function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function claudeToTelegram(markdown: string): string {
  let result = "";

  // Split by code blocks, preserving the delimiters
  const parts = markdown.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```")) {
      const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      if (match) {
        const [, lang, code] = match;
        const escaped = escapeHtml(code.trimEnd());
        if (lang) {
          result += `<pre><code class="language-${lang}">${escaped}</code></pre>`;
        } else {
          result += `<pre>${escaped}</pre>`;
        }
      } else {
        result += escapeHtml(part);
      }
    } else {
      // Extract inline code to protect from further processing
      const inlineCodes: string[] = [];
      let text = part.replace(/`([^`]+)`/g, (_, code) => {
        inlineCodes.push(escapeHtml(code));
        return `\x00IC${inlineCodes.length - 1}\x00`;
      });

      // Escape HTML in regular text
      text = escapeHtml(text);

      // Bold: **text**
      text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

      // Italic: *text* (not preceded/followed by word chars to avoid false matches)
      text = text.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");

      // Links: [text](url)
      text = text.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2">$1</a>'
      );

      // Restore inline code
      text = text.replace(
        /\x00IC(\d+)\x00/g,
        (_, i) => `<code>${inlineCodes[Number(i)]}</code>`
      );

      result += text;
    }
  }

  return result;
}

export function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];

  const messages: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      messages.push(remaining);
      break;
    }

    // Try to find a good split point
    let splitIdx = remaining.lastIndexOf("\n", limit);
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(" ", limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = limit;
    }

    messages.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return messages;
}

export function formatToolCall(
  toolName: string,
  input: Record<string, unknown>
): string {
  const inp = input as Record<string, string>;

  switch (toolName) {
    case "Bash":
      return (
        `<b>Bash Command</b>\n` +
        `<pre>${escapeHtml(inp.command || "")}</pre>`
      );

    case "Edit":
      return (
        `<b>Edit File</b>: <code>${escapeHtml(inp.file_path || "")}</code>\n` +
        `Old:\n<pre>${escapeHtml((inp.old_string || "").slice(0, 300))}</pre>\n` +
        `New:\n<pre>${escapeHtml((inp.new_string || "").slice(0, 300))}</pre>`
      );

    case "Write":
      return (
        `<b>Write File</b>: <code>${escapeHtml(inp.file_path || "")}</code>\n` +
        `<pre>${escapeHtml((inp.content || "").slice(0, 500))}</pre>`
      );

    case "NotebookEdit":
      return (
        `<b>Notebook Edit</b>: <code>${escapeHtml(inp.notebook_path || "")}</code>\n` +
        `<pre>${escapeHtml((inp.new_source || "").slice(0, 500))}</pre>`
      );

    default:
      return (
        `<b>${escapeHtml(toolName)}</b>\n` +
        `<pre>${escapeHtml(JSON.stringify(input, null, 2).slice(0, 500))}</pre>`
      );
  }
}
