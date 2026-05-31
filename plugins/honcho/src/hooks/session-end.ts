import { loadConfig, getSessionName, isPluginEnabled, getCachedStdin } from "../config.js";
import { existsSync, readFileSync } from "fs";
import {
  generateClaudeSummary,
  saveClaudeLocalContext,
  loadClaudeLocalContext,
  getInstanceIdForCwd,
} from "../cache.js";
import { logHook, setLogContext } from "../log.js";


interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  reason?: string;
  workspace_roots?: string[];
}

interface TranscriptEntry {
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content: string | Array<{ type: string; text?: string; name?: string; input?: any }>;
  };
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

/**
 * Check if assistant content is meaningful prose vs just tool acknowledgment
 */
function isMeaningfulAssistantContent(content: string): boolean {
  if (content.length < 50) return false;

  const toolAnnouncements = [
    /^(I'll|Let me|I'm going to|I will|Now I'll|First,? I'll)\s+(run|use|execute|check|read|look at|search|edit|write|create)/i,
    /^Running\s+/i,
    /^Checking\s+/i,
    /^Looking at\s+/i,
  ];
  for (const pattern of toolAnnouncements) {
    if (pattern.test(content.trim()) && content.length < 200) {
      return false;
    }
  }

  if (/^(The command|The file|The output|This shows|Here's what)/i.test(content.trim()) && content.length < 150) {
    return false;
  }

  const meaningfulPatterns = [
    /\b(because|since|therefore|however|although|this means|in summary|to summarize|the issue is|the problem is|I recommend|you should|we should|this approach|the solution|key point|important|note that)\b/i,
    /\b(implemented|fixed|resolved|completed|added|created|updated|changed|modified|refactored)\b/i,
    /\b(error|bug|issue|problem|solution|fix|improvement|optimization)\b/i,
  ];
  for (const pattern of meaningfulPatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }

  return content.length >= 200;
}

function parseTranscript(transcriptPath: string): Array<{ role: string; content: string; isMeaningful?: boolean; timestamp?: string }> {
  const messages: Array<{ role: string; content: string; isMeaningful?: boolean; timestamp?: string }> = [];

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return messages;
  }

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const entry: TranscriptEntry = JSON.parse(line);
        const entryType = entry.type || entry.role;
        const messageContent = entry.message?.content || entry.content;

        if (entryType === "user" && messageContent) {
          const userContent =
            typeof messageContent === "string"
              ? messageContent
              : messageContent
                  .filter((p) => p.type === "text")
                  .map((p) => p.text || "")
                  .join("\n");
          if (userContent && userContent.trim()) {
            messages.push({ role: "user", content: userContent, timestamp: entry.timestamp });
          }
        } else if (entryType === "assistant" && messageContent) {
          let assistantContent = "";

          if (typeof messageContent === "string") {
            assistantContent = messageContent;
          } else if (Array.isArray(messageContent)) {
            const textBlocks = messageContent
              .filter((p) => p.type === "text" && p.text)
              .map((p) => p.text!)
              .join("\n\n");

            const toolUses = messageContent
              .filter((p) => p.type === "tool_use")
              .map((p: any) => p.name)
              .filter(Boolean);

            assistantContent = textBlocks;

            if (toolUses.length > 0 && textBlocks.length < 100) {
              assistantContent = textBlocks + (textBlocks ? "\n" : "") + `[Used tools: ${toolUses.join(", ")}]`;
            }
          }

          if (assistantContent && assistantContent.trim()) {
            const isMeaningful = isMeaningfulAssistantContent(assistantContent);
            const maxLen = isMeaningful ? 3000 : 1500;
            messages.push({
              role: "assistant",
              content: assistantContent.slice(0, maxLen),
              isMeaningful,
              timestamp: entry.timestamp,
            });
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Failed to read transcript
  }

  return messages;
}

function extractWorkItems(assistantMessages: string[]): string[] {
  const workItems: string[] = [];
  const actionPatterns = [
    /(?:created|wrote|added)\s+(?:file\s+)?([^\n.]+)/gi,
    /(?:edited|modified|updated|fixed)\s+([^\n.]+)/gi,
    /(?:implemented|built|developed)\s+([^\n.]+)/gi,
    /(?:refactored|optimized|improved)\s+([^\n.]+)/gi,
  ];

  for (const msg of assistantMessages.slice(-15)) {
    for (const pattern of actionPatterns) {
      const matches = msg.matchAll(pattern);
      for (const match of matches) {
        const item = match[1]?.trim();
        if (item && item.length < 100 && !workItems.includes(item)) {
          workItems.push(item);
        }
      }
    }
  }

  return workItems.slice(0, 10);
}

/**
 * SessionEnd hook — local-only, by design.
 *
 * Assistant prose is uploaded turn-by-turn by the Stop hook, and user
 * prompts by the user-prompt hook, both in real time. Nothing is left to
 * flush at session end, so this hook performs no network I/O: it only
 * writes a local activity summary for the next session-start to read.
 *
 * This matters because Claude Code hard-kills SessionEnd hooks during
 * teardown (especially on prompt_input_exit) — fast enough that even the
 * first API round trip is cut off. The previous implementation fought this
 * with signal traps and a cooldown animation, which (a) produced the
 * "Hook cancelled" error when the kill won the race anyway, and (b) on the
 * rare occasion it did complete, re-uploaded assistant messages the Stop
 * hook had already saved, duplicating them. Going local-only removes both
 * problems: the hook finishes in milliseconds with nothing to cancel.
 */
export async function handleSessionEnd(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    process.exit(0);
  }

  if (!isPluginEnabled()) {
    process.exit(0);
  }

  let hookInput: HookInput = {};
  try {
    const input = getCachedStdin() ?? await Bun.stdin.text();
    if (input.trim()) {
      hookInput = JSON.parse(input);
    }
  } catch {
    // Continue with defaults
  }

  const cwd = hookInput.workspace_roots?.[0] || hookInput.cwd || process.cwd();
  const reason = hookInput.reason || "unknown";
  const transcriptPath = hookInput.transcript_path;
  const instanceId = hookInput.session_id || getInstanceIdForCwd(cwd);
  const sessionName = getSessionName(cwd, instanceId || undefined);

  setLogContext(cwd, sessionName);
  logHook("session-end", `Session ending`, { reason });

  // =========================================================
  // Phase 1: LOCAL WORK (instant, survives any cancellation)
  // =========================================================
  const transcriptMessages = transcriptPath ? parseTranscript(transcriptPath) : [];
  const allAssistant = transcriptMessages.filter((msg) => msg.role === "assistant");
  const meaningful = allAssistant.filter((msg) => msg.isMeaningful);
  const other = allAssistant.filter((msg) => !msg.isMeaningful);
  const assistantMessages = [
    ...meaningful.slice(-25),
    ...other.slice(-15),
  ].slice(-40);

  // Save local summary FIRST — even if the hook gets killed after this,
  // the next session-start will have context about what happened.
  const workItems = extractWorkItems(assistantMessages.map((m) => m.content));
  const existingContext = loadClaudeLocalContext();
  let recentActivity = "";
  if (existingContext) {
    const activityMatch = existingContext.match(/## Recent Activity\n([\s\S]*)/);
    if (activityMatch) {
      recentActivity = activityMatch[1];
    }
  }
  const newSummary = generateClaudeSummary(
    sessionName,
    workItems,
    assistantMessages.map((m) => m.content)
  );
  saveClaudeLocalContext(newSummary + recentActivity);

  const meaningfulCount = assistantMessages.filter((m) => m.isMeaningful).length;
  logHook(
    "session-end",
    `Local summary saved (${assistantMessages.length} assistant msgs, ${meaningfulCount} meaningful); real-time uploads already persisted`,
    { reason },
  );
  process.exit(0);
}
