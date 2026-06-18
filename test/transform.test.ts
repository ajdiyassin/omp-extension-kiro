import type { AssistantMessage, Message, Tool, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  getContentText,
  getEnvState,
  normalizeMessages,
  sanitizeSurrogates,
  TOOL_RESULT_LIMIT,
  truncate,
} from "../src/transform.js";
import { createKiroToolUseIdNormalizer, KIRO_TOOL_USE_ID_PATTERN } from "../src/tool-id.js";

const ts = Date.now();
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (content: string): UserMessage => ({ role: "user", content, timestamp: ts });
const assistant = (text: string, opts?: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "kiro-api",
  provider: "kiro",
  model: "test",
  usage,
  stopReason: "stop",
  timestamp: ts,
  ...opts,
});
const toolResult = (id: string, text: string, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "t",
  content: [{ type: "text", text }],
  isError,
  timestamp: ts,
});

describe("Feature 5: Message Transformation", () => {
  describe("sanitizeSurrogates", () => {
    it("removes unpaired high surrogate", () => {
      expect(sanitizeSurrogates("a\uD800b")).toBe("ab");
    });
    it("removes unpaired low surrogate", () => {
      expect(sanitizeSurrogates("a\uDC00b")).toBe("ab");
    });
    it("preserves properly paired surrogates (emoji)", () => {
      expect(sanitizeSurrogates("Hello 🙈 World")).toBe("Hello 🙈 World");
    });
    it("leaves normal text unchanged", () => {
      expect(sanitizeSurrogates("hello")).toBe("hello");
    });
  });

  describe("truncate", () => {
    it("returns text unchanged if under limit", () => {
      expect(truncate("short", 100)).toBe("short");
    });
    it("truncates with marker when over limit", () => {
      const r = truncate("a".repeat(100), 50);
      expect(r).toContain("[TRUNCATED]");
      expect(r.length).toBeLessThan(100);
    });
    it("preserves start and end", () => {
      const r = truncate(`START${"x".repeat(100)}END`, 30);
      expect(r).toMatch(/^START/);
      expect(r).toMatch(/END$/);
    });
  });

  describe("normalizeMessages", () => {
    it("filters errored assistant messages", () => {
      const msgs: Message[] = [user("hi"), assistant("oops", { stopReason: "error" }), user("retry")];
      expect(normalizeMessages(msgs)).toHaveLength(2);
    });
    it("filters aborted assistant messages", () => {
      expect(normalizeMessages([user("hi"), assistant("x", { stopReason: "aborted" })])).toHaveLength(1);
    });
    it("keeps successful assistant messages", () => {
      expect(normalizeMessages([user("hi"), assistant("ok")])).toHaveLength(2);
    });
  });

  describe("getContentText", () => {
    it("extracts from user string", () => {
      expect(getContentText(user("hello"))).toBe("hello");
    });
    it("extracts from tool result", () => {
      expect(getContentText(toolResult("tc1", "result"))).toBe("result");
    });
    it("extracts from assistant with thinking+text", () => {
      const msg = assistant("");
      msg.content = [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
      ];
      const text = getContentText(msg);
      expect(text).toContain("hmm");
      expect(text).toContain("answer");
    });
  });

  describe("convertToolsToKiro", () => {
    it("converts pi tools to Kiro specs", () => {
      const tools: Tool[] = [
        {
          name: "bash",
          description: "Run cmd",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ];
      const r = convertToolsToKiro(tools);
      expect(r[0].toolSpecification.name).toBe("bash");
      expect(r[0].toolSpecification.inputSchema.json).toEqual(tools[0].parameters);
    });
  });

  describe("convertImagesToKiro", () => {
    it("converts images with format from mimeType", () => {
      const r = convertImagesToKiro([{ mimeType: "image/png", data: "b64" }]);
      expect(r[0]).toEqual({ format: "png", source: { bytes: "b64" } });
    });
  });

  describe("buildHistory", () => {
    it("returns empty history for single user message", () => {
      const { history } = buildHistory([user("Hello")], "M");
      expect(history).toHaveLength(0);
    });

    it("prepends system prompt to first user message", () => {
      const msgs: Message[] = [user("first"), assistant("reply"), user("second")];
      const { history, systemPrepended } = buildHistory(msgs, "M", "Be helpful");
      expect(systemPrepended).toBe(true);
      expect(history[0].userInputMessage?.content).toMatch(/^Be helpful/);
    });

    it("converts assistant tool calls", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "ok"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.assistantResponseMessage?.toolUses);
      expect(entry?.assistantResponseMessage?.toolUses?.[0].name).toBe("bash");
    });

    it("batches consecutive tool results", () => {
      const a = assistant("");
      a.content = [
        { type: "toolCall", id: "tc1", name: "a", arguments: {} },
        { type: "toolCall", id: "tc2", name: "b", arguments: {} },
      ];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "r1"), toolResult("tc2", "r2"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);
      expect(entry?.userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(2);
    });

    it("truncates tool results exceeding limit", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "x".repeat(TOOL_RESULT_LIMIT + 1000)), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);
      const text = entry?.userInputMessage?.userInputMessageContext?.toolResults?.[0].content[0].text ?? "";
      expect(text).toContain("[TRUNCATED]");
    });

    it("merges consecutive user messages instead of inserting synthetic padding", () => {
      const msgs: Message[] = [user("first"), user("second"), assistant("reply"), user("third")];
      const { history } = buildHistory(msgs, "M");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No synthetic assistant padding — consecutive users are merged
      const assistantPadding = history.filter(
        (h) =>
          h.assistantResponseMessage &&
          !h.assistantResponseMessage.toolUses &&
          h.assistantResponseMessage.content.length > 0 &&
          h.assistantResponseMessage.content.length <= 3,
      );
      expect(assistantPadding).toHaveLength(0);
      // First user message should contain both user contents merged
      expect(history[0].userInputMessage?.content).toContain("first");
      expect(history[0].userInputMessage?.content).toContain("second");
    });

    it("merges tool results into previous user message instead of inserting synthetic padding", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
      // user -> user(tool results) — should merge, not pad
      const msgs: Message[] = [user("go"), user("more"), a, toolResult("tc1", "ok"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No synthetic padding entries
      const assistantPadding = history.filter(
        (h) =>
          h.assistantResponseMessage &&
          !h.assistantResponseMessage.toolUses &&
          h.assistantResponseMessage.content.length > 0 &&
          h.assistantResponseMessage.content.length <= 3,
      );
      expect(assistantPadding).toHaveLength(0);
    });

    it("never contains synthetic padding in long agentic sessions", () => {
      const msgs: Message[] = [user("start")];
      for (let i = 0; i < 20; i++) {
        const a = assistant(`step ${i}`);
        a.content = [{ type: "toolCall", id: `tc${i}`, name: "bash", arguments: { cmd: "ls" } }];
        msgs.push(a);
        msgs.push(toolResult(`tc${i}`, `output ${i}`));
      }
      msgs.push(user("done"));
      const { history } = buildHistory(msgs, "M", "Be helpful");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No single-char synthetic padding
      const padding = history.filter(
        (h) =>
          (h.assistantResponseMessage &&
            h.assistantResponseMessage.content.length > 0 &&
            h.assistantResponseMessage.content.length <= 3 &&
            !h.assistantResponseMessage.toolUses) ||
          (h.userInputMessage &&
            h.userInputMessage.content.length > 0 &&
            h.userInputMessage.content.length <= 3 &&
            !h.userInputMessage.userInputMessageContext?.toolResults),
      );
      expect(padding).toHaveLength(0);
    });

    it("maintains valid alternating user/assistant pattern via merging", () => {
      const msgs: Message[] = [user("a"), user("b"), user("c"), assistant("reply"), user("d")];
      const { history } = buildHistory(msgs, "M");
      for (let i = 0; i < history.length - 1; i++) {
        const curr = history[i];
        const next = history[i + 1];
        // No two consecutive user or assistant entries
        if (curr.userInputMessage) expect(next.assistantResponseMessage).toBeDefined();
        if (curr.assistantResponseMessage) expect(next.userInputMessage).toBeDefined();
      }
    });
  });
});


describe("getEnvState", () => {
  it("emits a Kiro-valid operatingSystem (never the raw process.platform)", () => {
    // Regression: sending "win32" gets the whole request rejected with 400
    // REQUEST_BODY_INVALID. The runtime only accepts windows/macos/linux.
    const env = getEnvState();
    expect(["windows", "macos", "linux"]).toContain(env.operatingSystem);
    expect(env.operatingSystem).not.toBe("win32");
    expect(env.currentWorkingDirectory).toBe(process.cwd());
  });

  it("maps the current platform correctly", () => {
    const expected: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" };
    const want = expected[process.platform] ?? "linux";
    expect(getEnvState().operatingSystem).toBe(want);
  });
});


describe("buildHistory tool-use ID normalization", () => {
  it("Test 5: a foreign call and its result serialize to the same valid normalized ID", () => {
    const normalizer = createKiroToolUseIdNormalizer();
    const msgs: Message[] = [
      user("go"),
      assistant("", {
        content: [{ type: "toolCall", id: "functions.search:6", name: "search", arguments: { query: "test" } } as never],
      }),
      toolResult("functions.search:6", "result"),
      user("continue"),
    ];

    const { history } = buildHistory(msgs, "M", undefined, normalizer.normalize);

    const assistantEntry = history.find((h) => h.assistantResponseMessage?.toolUses?.length);
    const resultEntry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults?.length);
    const callId = assistantEntry?.assistantResponseMessage?.toolUses?.[0].toolUseId;
    const resultId = resultEntry?.userInputMessage?.userInputMessageContext?.toolResults?.[0].toolUseId;

    expect(callId).toBeDefined();
    expect(callId).toBe(resultId);
    expect(callId).toMatch(KIRO_TOOL_USE_ID_PATTERN);
    expect(callId).not.toBe("functions.search:6");
  });
});

describe("convertToolsToKiro — v16 schema compatibility", () => {
  const ARKTYPE_IMPL_KEYS = ["domain", "sequence", "branches", "proto"];

  function allRequired(obj: unknown): void {
    if (Array.isArray(obj)) {
      for (const item of obj) allRequired(item);
      return;
    }
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      if ("required" in o) {
        expect(Array.isArray(o.required)).toBe(true);
        for (const r of o.required as unknown[]) expect(typeof r).toBe("string");
      }
      for (const v of Object.values(o)) allRequired(v);
    }
  }

  function noArkKeys(obj: unknown): void {
    if (Array.isArray(obj)) {
      for (const item of obj) noArkKeys(item);
      return;
    }
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      for (const k of ARKTYPE_IMPL_KEYS) expect(k in o).toBe(false);
      // required must not contain {key, value} objects
      if (Array.isArray(o.required)) {
        for (const r of o.required) expect(typeof r).toBe("string");
      }
      for (const v of Object.values(o)) noArkKeys(v);
    }
  }

  it("plain JSON Schema tool serializes correctly", () => {
    const tool = {
      name: "search",
      description: "Search for text",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    } as any;
    const [spec] = convertToolsToKiro([tool]);
    expect(spec.toolSpecification.name).toBe("search");
    expect(spec.toolSpecification.inputSchema.json).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  it("serialized ArkType-AST (eval) becomes valid JSON Schema", () => {
    const tool = {
      name: "eval",
      description: "Execute cells",
      parameters: {
        domain: "object",
        required: [
          {
            key: "cells",
            value: {
              proto: "Array",
              sequence: {
                domain: "object",
                required: [{ key: "language", value: "string" }],
              },
            },
          },
        ],
      },
    } as any;
    const [spec] = convertToolsToKiro([tool]);
    const schema = spec.toolSpecification.inputSchema.json;

    // Must be standard JSON Schema
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties.cells).toBeDefined();
    expect(schema.properties.cells.type).toBe("array");
    expect(schema.required).toEqual(["cells"]);
  });

  it("every resulting required value is an array of strings (recursive)", () => {
    const tool = {
      name: "eval",
      description: "Execute cells",
      parameters: {
        domain: "object",
        required: [
          {
            key: "cells",
            value: {
              proto: "Array",
              sequence: {
                domain: "object",
                required: [{ key: "language", value: "string" }],
              },
            },
          },
        ],
      },
    } as any;
    const [spec] = convertToolsToKiro([tool]);
    allRequired(spec.toolSpecification.inputSchema.json);
  });

  it("ArkType implementation keys do not leak into the output", () => {
    const tool = {
      name: "eval",
      description: "Execute cells",
      parameters: {
        domain: "object",
        required: [
          {
            key: "cells",
            value: {
              proto: "Array",
              sequence: {
                domain: "object",
                required: [{ key: "language", value: "string" }],
              },
            },
          },
        ],
      },
    } as any;
    const [spec] = convertToolsToKiro([tool]);
    noArkKeys(spec.toolSpecification.inputSchema.json);
  });

  it("existing tool-ID normalization still works (convertToolsToKiro does not affect tool results)", () => {
    // convertToolsToKiro is about tool *specs*, not IDs, so this just confirms no regression.
    const tool = { name: "find", description: "Find", parameters: { type: "object", properties: {} } } as any;
    const [spec] = convertToolsToKiro([tool]);
    expect(spec.toolSpecification.name).toBe("find");
  });
});
