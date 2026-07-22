// Feature 5: Message Transformation

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type { KiroModelRequestFields } from "./adaptive-thinking.js";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}
export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}
export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}
export interface KiroEnvState {
  operatingSystem: string;
  currentWorkingDirectory: string;
}
export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: {
    toolResults?: KiroToolResult[];
    tools?: KiroToolSpec[];
    envState?: KiroEnvState;
    // experiment: "user-input-context" adaptive payload shape
    additionalModelRequestFields?: KiroModelRequestFields;
  };
  // experiment: "user-input-message" adaptive payload shape
  additionalModelRequestFields?: KiroModelRequestFields;
}

/** Map Node's process.platform to the operatingSystem enum the Kiro runtime accepts. */
const KIRO_OS: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" };

/** Build the envState block kiro-cli sends on every userInputMessage. */
export function getEnvState(): KiroEnvState {
  // The runtime validates operatingSystem against a fixed enum. Sending the raw
  // process.platform value ("win32") is rejected with 400 REQUEST_BODY_INVALID;
  // kiro-cli sends "windows" / "macos" / "linux".
  return {
    operatingSystem: KIRO_OS[process.platform] ?? "linux",
    currentWorkingDirectory: process.cwd(),
  };
}
export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export const TOOL_RESULT_LIMIT = 250000;

export function sanitizeSurrogates(text: string): string {
  // Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
  // Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
  // Properly paired surrogates (e.g. emoji like 🙈) are preserved.
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

export function normalizeMessages(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const am = msg as AssistantMessage;
    return am.stopReason !== "error" && am.stopReason !== "aborted";
  });
}

function isImageContent(content: unknown): content is ImageContent {
  if (typeof content !== "object" || content === null) return false;
  const candidate = content as Partial<ImageContent>;
  return candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string";
}

export function extractImages(msg: Message): ImageContent[] {
  if (msg.role === "toolResult" || typeof msg.content === "string") return [];
  if (!Array.isArray(msg.content)) return [];
  const images: ImageContent[] = [];
  for (const content of msg.content) {
    if (isImageContent(content)) images.push(content);
  }
  return images;
}

export function getContentText(msg: Message): string {
  if (msg.role === "toolResult") return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Kiro rejects tool definitions with an empty description (REQUEST_BODY_INVALID /
 * "Invalid tool use format"). OMP 16.1.x prunes provider-bound tool descriptions when
 * the full text is already in the system prompt (Inline Tool Descriptors), leaving them
 * empty. Preserve any non-empty description; otherwise emit a minimal placeholder.
 */
export function kiroToolDescription(tool: Tool): string {
  const description = tool.description?.trim();
  return description || `Use the ${tool.name} tool.`;
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: kiroToolDescription(tool),
      inputSchema: { json: toolWireSchema(tool) },
    },
  }));
}

export function convertImagesToKiro(images: Array<{ mimeType: string; data: string }>): KiroImage[] {
  return images.map((img) => ({ format: img.mimeType.split("/")[1] || "png", source: { bytes: img.data } }));
}

export function buildHistory(
  messages: Message[],
  modelId: string,
  systemPrompt?: string,
  normalizeToolUseId: (id: string) => string = (id) => id,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;
  const toolResultLimit = TOOL_RESULT_LIMIT;

  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx].role === "toolResult") currentMsgStartIdx--;
  if (currentMsgStartIdx >= 0 && messages[currentMsgStartIdx].role === "assistant") {
    const am = messages[currentMsgStartIdx] as AssistantMessage;
    if (!Array.isArray(am.content) || !am.content.some((b) => b.type === "toolCall")) currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    switch (msg.role) {
      // Kiro has no separate developer role; developer content (skills, hooks,
      // extension/file-mention context) is serialized as user-side input.
      case "user":
      case "developer": {
        let content = typeof msg.content === "string" ? msg.content : getContentText(msg);
        if (systemPrompt && !systemPrepended) {
          content = `${systemPrompt}\n\n${content}`;
          systemPrepended = true;
        }
        const images = extractImages(msg);
        const uim: KiroUserInputMessage = {
          content: sanitizeSurrogates(content),
          modelId,
          origin: "KIRO_CLI",
          ...(images.length > 0 ? { images: convertImagesToKiro(images) } : {}),
          userInputMessageContext: { envState: getEnvState() },
        };
        const prevUim = history[history.length - 1]?.userInputMessage;
        if (prevUim) {
          // Merge adjacent user-side (user/developer) messages; original order preserved.
          prevUim.content += `\n\n${uim.content}`;
          if (uim.images) prevUim.images = [...(prevUim.images || []), ...uim.images];
        } else {
          history.push({ userInputMessage: uim });
        }
        break;
      }
      case "assistant": {
        let armContent = "";
        const armToolUses: KiroToolUse[] = [];
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") armContent += (block as TextContent).text;
            else if (block.type === "thinking")
              armContent = `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n${armContent}`;
            else if (block.type === "toolCall") {
              const tc = block as ToolCall;
              armToolUses.push({
                name: tc.name,
                toolUseId: normalizeToolUseId(tc.id),
                input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
              });
            }
            // redactedThinking: intentionally skipped — opaque provider-specific
            // reasoning data with no Kiro text representation.
          }
        }
        if (armContent || armToolUses.length > 0) {
          history.push({
            assistantResponseMessage: {
              content: armContent,
              ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
            },
          });
        }
        break;
      }
      case "toolResult": {
        const trMsg = msg as ToolResultMessage;
        const toolResults: KiroToolResult[] = [
          {
            content: [{ text: truncate(getContentText(msg), toolResultLimit) }],
            status: trMsg.isError ? "error" : "success",
            toolUseId: normalizeToolUseId(trMsg.toolCallId),
          },
        ];
        const trImages: ImageContent[] = [];
        if (Array.isArray(trMsg.content))
          for (const c of trMsg.content) if (c.type === "image") trImages.push(c as ImageContent);
        let j = i + 1;
        while (j < historyMessages.length && historyMessages[j].role === "toolResult") {
          const next = historyMessages[j] as ToolResultMessage;
          toolResults.push({
            content: [{ text: truncate(getContentText(next), toolResultLimit) }],
            status: next.isError ? "error" : "success",
            toolUseId: normalizeToolUseId(next.toolCallId),
          });
          if (Array.isArray(next.content))
            for (const c of next.content) if (c.type === "image") trImages.push(c as ImageContent);
          j++;
        }
        i = j - 1;
        const prevTr = history[history.length - 1]?.userInputMessage;
        if (prevTr) {
          prevTr.content += "\n\nTool results provided.";
          if (trImages.length > 0) prevTr.images = [...(prevTr.images || []), ...convertImagesToKiro(trImages)];
          if (!prevTr.userInputMessageContext) prevTr.userInputMessageContext = {};
          prevTr.userInputMessageContext.toolResults = [
            ...(prevTr.userInputMessageContext.toolResults || []),
            ...toolResults,
          ];
        } else {
          history.push({
            userInputMessage: {
              content: "Tool results provided.",
              modelId,
              origin: "KIRO_CLI",
              ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages) } : {}),
              userInputMessageContext: { toolResults, envState: getEnvState() },
            },
          });
        }
        break;
      }
      default:
        // Exhaustiveness guard: a new OMP message role must be handled explicitly.
        msg satisfies never;
    }
  }
  return { history, systemPrepended, currentMsgStartIdx };
}
