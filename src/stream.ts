// ABOUTME: Core streaming integration for Kiro API requests and responses.
// ABOUTME: Handles request building, retry logic, event parsing, and token counting.

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import {
  ADAPTIVE_PAYLOAD_LOCATIONS,
  type AdaptivePayloadShape,
  buildKiroModelRequestFields,
  getAdaptiveFieldSet,
  getAdaptivePayloadShape,
  type KiroAnthropicRequestFields,
  type KiroGptRequestFields,
  type KiroModelRequestFields,
  type OmpEffort,
} from "./adaptive-thinking.js";
import { clearAuthMeta, readAuthMeta, writeAuthMeta } from "./auth-meta.js";
import { parseBracketToolCalls } from "./bracket-tool-parser.js";
import { debugEnabled, debugLog } from "./debug.js";
import { parseKiroEvents } from "./event-parser.js";
import { createAssistantMessageEventStream } from "./event-stream.js";
import { addPlaceholderTools, HISTORY_LIMIT, HISTORY_LIMIT_CONTEXT_WINDOW, truncateHistory } from "./history.js";
import {
  getKiroCliCredentials,
  getKiroCliCredentialsAllowExpired,
  getKiroCliSocialToken,
  saveKiroCliCredentials,
} from "./kiro-cli.js";
import {
  endpointForApiRegion,
  extractRegionFromEndpoint,
  extractRegionFromProfileArn,
  managementEndpointForApiRegion,
  resolveApiRegion,
  resolveKiroModel,
} from "./models.js";
import { forceRefreshKiroToken, getKiroCredentialsFromOptions, type KiroCredentials } from "./oauth.js";
import {
  capacityRetryConfig,
  exponentialBackoff,
  firstTokenTimeout,
  isCapacityError,
  isNonRetryableBodyError,
  isRequestBodyInvalidError,
  isTooBigError,
  MAX_RETRY_DELAY,
} from "./retry.js";
import { ThinkingTagParser } from "./thinking-parser.js";
import { countTokens } from "./tokenizer.js";
import { createKiroToolUseIdNormalizer, KIRO_TOOL_USE_ID_PATTERN } from "./tool-id.js";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  extractImages,
  getContentText,
  getEnvState,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroUserInputMessage,
  normalizeMessages,
  sanitizeSurrogates,
  TOOL_RESULT_LIMIT,
  truncate,
} from "./transform.js";
import { TRUNCATION_NOTICE, wasPreviousResponseTruncated } from "./truncation.js";

const CAPACITY_LOG_DIR = join(homedir(), ".pi", "logs");
const CAPACITY_LOG_FILE = join(CAPACITY_LOG_DIR, "capacity-retries.log");

let capacityLogDirCreated = false;

function logCapacityEvent(message: string): void {
  // Fire-and-forget async logging to avoid blocking the event loop
  (async () => {
    try {
      if (!capacityLogDirCreated) {
        await mkdir(CAPACITY_LOG_DIR, { recursive: true });
        capacityLogDirCreated = true;
      }
      await appendFile(CAPACITY_LOG_FILE, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // best-effort logging, don't break the provider
    }
  })();
}

/** Delay that rejects early if the abort signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    agentContinuationId?: string;
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  profileArn?: string;
  // experiment: "top-level-wrapper" adaptive payload shape
  additionalModelRequestFields?: KiroModelRequestFields;
  // experiment: "top-level-direct" provider request fields (payload fields spread as siblings)
  thinking?: KiroAnthropicRequestFields["thinking"];
  output_config?: KiroAnthropicRequestFields["output_config"];
  max_tokens?: number;
  reasoning?: KiroGptRequestFields["reasoning"];
}

/**
 * Place the adaptive payload into the request at the configured location.
 * Mutates `request` in place. Only called when adaptive thinking is enabled and
 * a payload was built, so normal requests are completely unaffected.
 */
export function applyAdaptivePayloadShape(
  request: KiroRequest,
  payload: KiroModelRequestFields,
  shape: AdaptivePayloadShape,
): void {
  const uim = request.conversationState.currentMessage.userInputMessage;
  switch (shape) {
    case "top-level-wrapper":
      request.additionalModelRequestFields = payload;
      break;
    case "top-level-direct":
      if ("reasoning" in payload) {
        request.reasoning = payload.reasoning;
      } else {
        if (payload.thinking) request.thinking = payload.thinking;
        request.output_config = payload.output_config;
        if (payload.max_tokens !== undefined) request.max_tokens = payload.max_tokens;
      }
      break;
    case "user-input-message":
      uim.additionalModelRequestFields = payload;
      break;
    case "user-input-context":
      uim.userInputMessageContext ??= {};
      uim.userInputMessageContext.additionalModelRequestFields = payload;
      break;
  }
}

/**
 * Validate every tool-use ID in the serialized Kiro request. Throws a local, descriptive error
 * before the network call if any ID is still invalid after normalization, preventing an opaque
 * Bedrock 400 (TOOL_SCHEMA_INVALID). Does not mutate the request.
 */
export function assertValidKiroToolUseIds(request: KiroRequest): void {
  const check = (id: string | undefined): void => {
    if (id === undefined) return;
    if (!KIRO_TOOL_USE_ID_PATTERN.test(id)) {
      throw new Error(`Kiro request contains invalid toolUseId after normalization: ${id}`);
    }
  };
  for (const entry of request.conversationState.history ?? []) {
    for (const tu of entry.assistantResponseMessage?.toolUses ?? []) check(tu.toolUseId);
    for (const tr of entry.userInputMessage?.userInputMessageContext?.toolResults ?? []) check(tr.toolUseId);
  }
  const currentCtx = request.conversationState.currentMessage.userInputMessage.userInputMessageContext;
  for (const tr of currentCtx?.toolResults ?? []) check(tr.toolUseId);
}
interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

// --- profileArn resolution (cached per endpoint) ---
const profileArnCache = new Map<string, string>();
const profileArnPending = new Set<string>();

/** Reset profileArn cache — exported for tests. */
export function resetProfileArnCache(resolved = false): void {
  profileArnCache.clear();
  profileArnPending.clear();
  if (resolved) profileArnPending.add("__all__");
}

async function resolveProfileArn(accessToken: string, endpoint: string): Promise<string | undefined> {
  if (profileArnPending.has("__all__")) return undefined;
  if (profileArnCache.has(endpoint)) return profileArnCache.get(endpoint);
  if (profileArnPending.has(endpoint)) return undefined;
  try {
    // Derive management host from runtime endpoint: runtime.{region}.kiro.dev -> management.{region}.kiro.dev
    const region = extractRegionFromEndpoint(endpoint) ?? "us-east-1";
    const mgmtEndpoint = managementEndpointForApiRegion(region);

    const r = await fetch(mgmtEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Authorization: `Bearer ${accessToken}`,
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
      },
      body: "{}",
    });
    if (!r.ok) {
      console.warn(
        `[omp-provider-kiro] Failed to resolve profileArn: ListAvailableProfiles returned ${r.status} ${r.statusText}. Will retry on the next request.`,
      );
      return undefined;
    }
    const j = (await r.json()) as { profiles?: Array<{ arn?: string }> };
    const arn = j.profiles?.find((p) => p.arn)?.arn;
    if (!arn) {
      debugLog("profileArn.empty", {
        message: "ListAvailableProfiles returned no profile ARN; this is expected for some social-login tokens.",
      });
      return undefined;
    }
    profileArnCache.set(endpoint, arn);
    return arn;
  } catch (error) {
    console.warn(
      `[omp-provider-kiro] Failed to resolve profileArn: ${error instanceof Error ? error.message : String(error)}. Will retry on the next request.`,
    );
    return undefined;
  }
}

function emitToolCall(
  state: KiroToolCallState,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): boolean {
  if (!state.input.trim()) {
    // Kiro API omits the input payload when the model calls a tool with no
    // arguments (e.g. mcp({})). Treat empty input as an empty object rather
    // than skipping — these are valid zero-arg tool calls, not truncations.
    state.input = "{}";
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(state.input) as Record<string, unknown>;
  } catch (e) {
    console.warn(
      `[omp-provider-kiro] Failed to parse tool input for "${state.name}" (toolUseId: ${state.toolUseId}): ${e instanceof Error ? e.message : String(e)}. Raw input (${state.input.length} chars): ${state.input.substring(0, 200)}`,
    );
    return false;
  }

  const contentIndex = output.content.length;
  const toolCall: ToolCall = { type: "toolCall", id: state.toolUseId, name: state.name, arguments: args };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: state.input, partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
  return true;
}

const KIRO_API_BOOTSTRAP_REGIONS = ["us-east-1", "eu-central-1"];

async function autoDetectKiroApiRegion(
  accessToken: string,
): Promise<{ apiRegion: string; endpoint: string; profileArn?: string } | undefined> {
  for (const apiRegion of KIRO_API_BOOTSTRAP_REGIONS) {
    const endpoint = endpointForApiRegion(apiRegion);
    const arn = await resolveProfileArn(accessToken, endpoint);
    if (arn) return { apiRegion, endpoint, profileArn: arn };
  }
  return undefined;
}

export function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      // M4: KIRO_API_KEY — version-independent API-key auth (no kiro-cli DB, no
      // OAuth device flow). Paid-tier credential (Pro/Pro+/Pro Max/Power). Sent
      // verbatim as the Bearer token. Highest precedence after an explicit OMP
      // apiKey.
      const envApiKey = process.env.KIRO_API_KEY;
      const suppliedOptionCreds = getKiroCredentialsFromOptions(options);
      const cliCreds = getKiroCliSocialToken() ?? getKiroCliCredentials();
      const expiredCliCreds = getKiroCliCredentialsAllowExpired();
      let accessToken = (options?.apiKey as string | undefined) ?? envApiKey ?? cliCreds?.access;
      const usingApiKey = Boolean(envApiKey && accessToken === envApiKey);
      if (!accessToken)
        throw new Error("Kiro credentials not set. Run /login kiro, install kiro-cli, or set KIRO_API_KEY.");
      const optionCreds = suppliedOptionCreds?.access === accessToken ? suppliedOptionCreds : undefined;

      const matchingCliCreds =
        cliCreds?.access === accessToken
          ? cliCreds
          : expiredCliCreds?.access === accessToken
            ? expiredCliCreds
            : undefined;

      const cachedMeta = readAuthMeta(accessToken);

      // API-key auth has no profileArn/region in the token — default to us-east-1
      // and skip profileArn resolution.
      const requestedRegion =
        process.env.KIRO_API_REGION ||
        optionCreds?.region ||
        extractRegionFromProfileArn(optionCreds?.profileArn) ||
        (usingApiKey ? "us-east-1" : undefined) ||
        cachedMeta?.apiRegion ||
        extractRegionFromProfileArn(cachedMeta?.profileArn) ||
        matchingCliCreds?.region ||
        extractRegionFromProfileArn(matchingCliCreds?.profileArn);

      let apiRegion: string;
      let endpoint: string;
      let profileArn: string | undefined =
        optionCreds?.profileArn || matchingCliCreds?.profileArn || cachedMeta?.profileArn;

      if (requestedRegion) {
        apiRegion = resolveApiRegion(requestedRegion);
        endpoint = endpointForApiRegion(apiRegion);
        profileArn = usingApiKey ? undefined : profileArn || (await resolveProfileArn(accessToken, endpoint));
      } else {
        const detected = await autoDetectKiroApiRegion(accessToken);
        if (detected) {
          apiRegion = detected.apiRegion;
          endpoint = detected.endpoint;
          profileArn = detected.profileArn;
        } else {
          apiRegion = resolveApiRegion(extractRegionFromEndpoint(model.baseUrl));
          endpoint = endpointForApiRegion(apiRegion);
          profileArn = usingApiKey ? undefined : await resolveProfileArn(accessToken, endpoint);
        }
      }

      if (profileArn) {
        const profileRegion = extractRegionFromProfileArn(profileArn);
        writeAuthMeta(accessToken, { apiRegion: profileRegion || apiRegion, profileArn, updatedAt: Date.now() });
        if (matchingCliCreds && !matchingCliCreds.region) {
          saveKiroCliCredentials({ ...matchingCliCreds, region: profileRegion || apiRegion, profileArn });
        }
      }

      const kiroModelId = resolveKiroModel(model.id);
      const requestFields = buildKiroModelRequestFields(model, options?.reasoning as OmpEffort | undefined);
      const requestFieldsPayloadShape = requestFields ? getAdaptivePayloadShape() : undefined;
      const adaptiveFields = requestFields && !("reasoning" in requestFields) ? getAdaptiveFieldSet() : undefined;
      debugLog("request.init", {
        endpoint,
        apiRegion,
        credentialRegion: optionCreds?.region,
        cachedRegion: cachedMeta?.apiRegion,
        cliRegion: matchingCliCreds?.region,
        envRegion: process.env.KIRO_API_REGION,
        autoDetected: !requestedRegion,
        model: model.id,
        kiroModelId,
        contextWindow: model.contextWindow,
        requestFieldsEnabled: Boolean(requestFields),
        requestFieldsFamily: requestFields ? ("reasoning" in requestFields ? "gpt" : "anthropic") : undefined,
        requestFieldsPayloadShape,
        requestFieldsPayloadLocation: requestFieldsPayloadShape
          ? ADAPTIVE_PAYLOAD_LOCATIONS[requestFieldsPayloadShape]
          : undefined,
        adaptiveFields,
        kiroEffort: requestFields
          ? "reasoning" in requestFields
            ? requestFields.reasoning.effort
            : requestFields.output_config.effort
          : undefined,
        maxTokens: requestFields && !("reasoning" in requestFields) ? requestFields.max_tokens : undefined,
        reasoning: options?.reasoning,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        hasSystemPrompt: !!context.systemPrompt,
        profileArn,
        sessionId: options?.sessionId,
      });
      // System prompt is sent plain — adaptive thinking is controlled via
      // additionalModelRequestFields, not legacy extended-thinking XML.
      const systemPrompt = Array.isArray(context.systemPrompt)
        ? context.systemPrompt.join("\n")
        : (context.systemPrompt ?? "");
      let retryCount = 0;
      const maxRetries = 3;
      const conversationId = options?.sessionId ?? crypto.randomUUID();
      const agentContinuationId = crypto.randomUUID();
      // One normalizer per request: foreign tool-call IDs (e.g. Kimi's "functions.find:4") are
      // mapped to Kiro-safe IDs at serialization time only. Created before the retry loop so
      // retries rebuild the same request with identical, stable mappings.
      const toolUseIdNormalizer = createKiroToolUseIdNormalizer();
      let loggedToolIds = false;
      while (retryCount <= maxRetries) {
        if (options?.signal?.aborted) throw options.signal.reason;
        const effectiveSystemPrompt = systemPrompt;
        const normalized = normalizeMessages(context.messages);
        const {
          history: rawHistory,
          systemPrepended,
          currentMsgStartIdx,
        } = buildHistory(normalized, kiroModelId, effectiveSystemPrompt, (id) => toolUseIdNormalizer.normalize(id));
        // Scale history limit to model context window
        // HISTORY_LIMIT (850K chars) is sized for 200K token models
        const dynamicHistoryLimit = Math.floor(
          ((model.contextWindow ?? 0) / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT,
        );
        const history = truncateHistory(rawHistory, dynamicHistoryLimit);
        const toolResultLimit = TOOL_RESULT_LIMIT;
        const currentMessages = normalized.slice(currentMsgStartIdx);
        const firstMsg = currentMessages[0];
        let currentContent = "";
        const currentToolResults: KiroToolResult[] = [];
        let currentImages: KiroImage[] | undefined;
        switch (firstMsg?.role) {
          case "assistant": {
            const am = firstMsg as AssistantMessage;
            let armContent = "";
            const armToolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
            if (Array.isArray(am.content))
              for (const b of am.content) {
                if (b.type === "text") armContent += (b as TextContent).text;
                else if (b.type === "thinking")
                  armContent = `<thinking>${(b as unknown as { thinking: string }).thinking}</thinking>\n\n${armContent}`;
                else if (b.type === "toolCall") {
                  const tc = b as ToolCall;
                  armToolUses.push({
                    name: tc.name,
                    toolUseId: toolUseIdNormalizer.normalize(tc.id),
                    input:
                      typeof tc.arguments === "string"
                        ? JSON.parse(tc.arguments)
                        : (tc.arguments as Record<string, unknown>),
                  });
                }
                // redactedThinking: intentionally skipped — opaque provider-specific
                // reasoning data with no Kiro text representation.
              }
            if (armContent || armToolUses.length > 0) {
              const lastEntryForArm = history[history.length - 1];
              const prevArm = lastEntryForArm?.assistantResponseMessage;
              if (history.length > 0 && !lastEntryForArm?.userInputMessage && prevArm) {
                prevArm.content += `\n\n${armContent}`;
                if (armToolUses.length > 0) prevArm.toolUses = [...(prevArm.toolUses || []), ...armToolUses];
              } else {
                history.push({
                  assistantResponseMessage: {
                    content: armContent,
                    ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
                  },
                });
              }
            }
            const toolResultImages: ImageContent[] = [];
            for (let i = 1; i < currentMessages.length; i++) {
              const m = currentMessages[i];
              if (m.role === "toolResult") {
                const trm = m as ToolResultMessage;
                currentToolResults.push({
                  content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                  status: trm.isError ? "error" : "success",
                  toolUseId: toolUseIdNormalizer.normalize(trm.toolCallId),
                });
                if (Array.isArray(trm.content))
                  for (const c of trm.content) if (c.type === "image") toolResultImages.push(c as ImageContent);
              }
            }
            if (toolResultImages.length > 0) {
              const converted = convertImagesToKiro(toolResultImages);
              currentImages = currentImages ? [...currentImages, ...converted] : converted;
            }
            currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Please proceed with the task.";
            break;
          }
          case "toolResult": {
            const toolResultImages2: ImageContent[] = [];
            for (const m of currentMessages)
              if (m.role === "toolResult") {
                const trm = m as ToolResultMessage;
                currentToolResults.push({
                  content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                  status: trm.isError ? "error" : "success",
                  toolUseId: toolUseIdNormalizer.normalize(trm.toolCallId),
                });
                if (Array.isArray(trm.content))
                  for (const c of trm.content) if (c.type === "image") toolResultImages2.push(c as ImageContent);
              }
            if (toolResultImages2.length > 0) {
              const converted = convertImagesToKiro(toolResultImages2);
              currentImages = currentImages ? [...currentImages, ...converted] : converted;
            }
            currentContent = "Tool results provided.";
            break;
          }
          // Kiro has no developer role; developer content (skills, hooks, file-mention
          // context) is serialized as user-side input — same path as "user".
          case "user":
          case "developer": {
            currentContent = typeof firstMsg.content === "string" ? firstMsg.content : getContentText(firstMsg);
            if (effectiveSystemPrompt && !systemPrepended)
              currentContent = `${effectiveSystemPrompt}\n\n${currentContent}`;
            const imgs = extractImages(firstMsg);
            if (imgs.length > 0) currentImages = convertImagesToKiro(imgs as ImageContent[]);
            break;
          }
          case undefined:
            break;
          default:
            // Exhaustiveness guard: a new OMP message role must be handled explicitly.
            firstMsg satisfies never;
        }
        // Prepend truncation notice if the previous assistant response was cut off
        if (wasPreviousResponseTruncated(context.messages)) {
          currentContent = `${TRUNCATION_NOTICE}\n\n${currentContent}`;
        }
        let uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } | undefined;
        if (currentToolResults.length > 0 || (context.tools && context.tools.length > 0)) {
          uimc = {};
          if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
          if (context.tools?.length) {
            let kt = convertToolsToKiro(context.tools);
            if (history.length > 0) kt = addPlaceholderTools(kt, history);
            uimc.tools = kt;
          }
        }
        // kiro-cli does not enforce alternation — the API accepts
        // non-alternating history. No synthetic padding needed.
        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            agentTaskType: "vibe",
            agentContinuationId,
            conversationId,
            currentMessage: {
              userInputMessage: {
                content: sanitizeSurrogates(currentContent),
                modelId: kiroModelId,
                origin: "KIRO_CLI",
                ...(currentImages ? { images: currentImages } : {}),
                userInputMessageContext: { ...(uimc ?? {}), envState: getEnvState() },
              },
            },
            ...(history.length > 0 ? { history } : {}),
          },
          ...(profileArn ? { profileArn } : {}),
        };
        if (requestFields && requestFieldsPayloadShape) {
          applyAdaptivePayloadShape(request, requestFields, requestFieldsPayloadShape);
        }
        // Fail fast locally if any tool-use ID is still invalid after normalization,
        // rather than letting Kiro reject it with an opaque 400 TOOL_SCHEMA_INVALID.
        assertValidKiroToolUseIds(request);
        // Log the foreign→Kiro ID mappings once per request (mappings are stable across retries).
        if (!loggedToolIds && debugEnabled()) {
          const normalizedToolIds = toolUseIdNormalizer.getMappings();
          if (normalizedToolIds.length > 0) {
            debugLog("tool_ids.normalized", { count: normalizedToolIds.length, mappings: normalizedToolIds });
          }
          loggedToolIds = true;
        }
        let response!: Response;
        // Reset per outer iteration — each 403 retry gets a fresh capacity budget
        let capacityRetryCount = 0;
        // Inner loop: retry capacity errors without consuming outer retry budget
        while (true) {
          const mid = crypto.randomUUID().replace(/-/g, "");
          const ua = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/windows lang/rust/1.92.0 exec-env/AmazonQ-For-CLI Version/2.6.1 md/appVersion-2.6.1-${mid} app/AmazonQ-For-CLI`;
          debugLog("request.send", {
            attempt: retryCount,
            capacityAttempt: capacityRetryCount,
            historyLen: history.length,
            currentContentLen: currentContent.length,
            hasImages: !!currentImages,
            toolResultCount: currentToolResults.length,
            request,
          });
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-amz-json-1.0",
              Accept: "application/vnd.amazon.eventstream",
              Authorization: `Bearer ${accessToken}`,
              "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
              "x-amzn-codewhisperer-optout": "false",
              "amz-sdk-invocation-id": crypto.randomUUID(),
              "amz-sdk-request": "attempt=1; max=3",
              "x-amz-user-agent": ua,
              "user-agent": ua,
            },
            body: JSON.stringify(request),
            signal: options?.signal,
          });
          if (!response.ok) {
            let errText = "";
            try {
              errText = await response.text();
            } catch {
              errText = "";
            }
            debugLog("response.error", { status: response.status, statusText: response.statusText, body: errText });
            // Retry transient capacity errors with longer backoff
            if (isCapacityError(errText) && capacityRetryCount < capacityRetryConfig.maxRetries) {
              capacityRetryCount++;
              const delayMs = exponentialBackoff(capacityRetryCount - 1, capacityRetryConfig.baseDelayMs, 30_000);
              const msg = `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${capacityRetryConfig.maxRetries})`;
              console.error(`[omp-provider-kiro] ${msg}`);
              logCapacityEvent(msg);
              await abortableDelay(delayMs, options?.signal);
              continue;
            }
            if (isCapacityError(errText)) {
              logCapacityEvent(
                `INSUFFICIENT_MODEL_CAPACITY — exhausted ${capacityRetryConfig.maxRetries} retries, giving up`,
              );
            }
            if (response.status === 403 && !isCapacityError(errText) && retryCount < maxRetries) {
              retryCount++;

              // First 403: try alternate region (wrong region is the most common cause)
              if (retryCount === 1 && !process.env.KIRO_API_REGION) {
                clearAuthMeta(accessToken);
                const detected = await autoDetectKiroApiRegion(accessToken);
                if (detected && detected.apiRegion !== apiRegion) {
                  apiRegion = detected.apiRegion;
                  endpoint = detected.endpoint;
                  profileArn = detected.profileArn;
                  writeAuthMeta(accessToken, { apiRegion, profileArn, updatedAt: Date.now() });
                  const delayMs = exponentialBackoff(retryCount - 1, 500, MAX_RETRY_DELAY);
                  await abortableDelay(delayMs, options?.signal);
                  break;
                }
              }

              // Refresh only the credential that exactly matches the bearer that received the 403.
              // Unrelated option/local credentials must never switch the active account.
              const candidates = (usingApiKey ? [] : [optionCreds, matchingCliCreds]).filter(
                (candidate): candidate is KiroCredentials =>
                  !!candidate?.refresh && candidate.access === accessToken,
              );

              let freshCreds: KiroCredentials | undefined;
              for (const candidate of candidates) {
                try {
                  freshCreds = (await forceRefreshKiroToken(candidate)) as KiroCredentials;
                  if (freshCreds?.access) break;
                } catch {
                  // Try next candidate
                }
              }

              if (freshCreds?.access) {
                accessToken = freshCreds.access;
                const refreshedApiRegion = resolveApiRegion(
                  freshCreds.region || extractRegionFromProfileArn(freshCreds.profileArn) || apiRegion,
                );
                endpoint = endpointForApiRegion(refreshedApiRegion);
              }

              profileArnCache.delete(endpoint);
              profileArn = freshCreds?.profileArn || (await resolveProfileArn(accessToken, endpoint));
              const delayMs = exponentialBackoff(retryCount - 1, 500, MAX_RETRY_DELAY);
              await abortableDelay(delayMs, options?.signal);
              break;
            }
            // Avoid pi-coding-agent's outer auto-retry from treating known
            // Kiro quota/capacity body markers as generic retryable 429s.
            // This covers both hard quota (MONTHLY_REQUEST_COUNT) and
            // exhausted capacity retries (INSUFFICIENT_MODEL_CAPACITY).
            if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
              throw new Error(`Kiro API error: ${errText || response.statusText}`);
            }
            // Format error so pi-ai's isContextOverflow() recognizes it
            if (isTooBigError(response.status, errText)) {
              throw new Error(`Kiro API error: context_length_exceeded (${response.status} ${errText})`);
            }
            // Schema/validation rejection (e.g. an unaccepted additionalModelRequestFields
            // shape). Surface explicitly so it is never mistaken for context overflow.
            if (isRequestBodyInvalidError(response.status, errText)) {
              throw new Error(`Kiro API error: request_body_invalid (${response.status} ${errText})`);
            }
            throw new Error(`Kiro API error: ${response.status} ${response.statusText} ${errText}`);
          }
          break; // success, break inner loop
        }
        if (capacityRetryCount > 0 && response.ok) {
          logCapacityEvent(`INSUFFICIENT_MODEL_CAPACITY — succeeded after ${capacityRetryCount} retries`);
        }
        // 403 retry: continue outer loop
        if (!response.ok) continue;
        stream.push({ type: "start", partial: output });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";
        let totalContent = "";
        let lastContentData = "";
        let usageEvent: { inputTokens?: number; outputTokens?: number } | null = null;
        let receivedContextUsage = false;
        const thinkingParser = model.reasoning ? new ThinkingTagParser(output, stream) : null;
        let textBlockIndex: number | null = null;
        let emittedToolCalls = 0;
        let sawAnyToolCalls = false;
        // Parsed from the Kiro assistantResponseEvent's additive stopReason
        // field. When present, it drives turn termination instead of the
        // inferred heuristic below (M2).
        let parsedStopReason: string | undefined;
        let currentToolCall: KiroToolCallState | null = null;
        const flushToolCall = () => {
          if (!currentToolCall) return;
          if (emitToolCall(currentToolCall, output, stream)) emittedToolCalls++;
          currentToolCall = null;
        };
        const IDLE_TIMEOUT = 300_000;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleCancelled = true;
            void reader.cancel().catch(() => {});
          }, IDLE_TIMEOUT);
        };
        let gotFirstToken = false;
        let firstTokenTimedOut = false;
        let idleCancelled = false;
        let streamError: string | null = null;
        const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");
        while (true) {
          let readResult: ReadableStreamReadResult<Uint8Array>;
          if (!gotFirstToken) {
            // First-token timeout: race the first read against a deadline.
            // Keep a reference to the read promise so we can suppress its
            // rejection if the timeout wins — otherwise an abort that fires
            // after the race settles leaves a dangling rejected promise.
            const readPromise = reader.read();
            const result = await Promise.race([
              readPromise,
              new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) =>
                setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), firstTokenTimeout()),
              ),
            ]);
            if (result === FIRST_TOKEN_SENTINEL) {
              readPromise.catch(() => {}); // suppress dangling rejection
              void reader.cancel().catch(() => {});
              firstTokenTimedOut = true;
              break;
            }
            readResult = result as ReadableStreamReadResult<Uint8Array>;
            gotFirstToken = true;
            resetIdle(); // Start idle timer after first token received
          } else {
            readResult = await reader.read();
          }
          const { done, value } = readResult;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseKiroEvents(buffer);
          buffer = remaining;
          if (debugEnabled() && events.length > 0) debugLog("stream.events", events);
          // Reset idle timer on any bytes received — large tool call inputs
          // span many chunks that parse as zero events (incomplete JSON) but
          // the stream is still actively flowing.
          resetIdle();
          for (const event of events) {
            switch (event.type) {
              case "reasoning": {
                // Emit reasoning content directly to pi's thinking output.
                // reasoningContentEvent carries the model's native reasoning
                // as a separate event type — NOT as inline <thinking> tags.
                // Use emitReasoning() to bypass the tag parser and write
                // directly to the thinking block.
                if (model.reasoning && thinkingParser) {
                  const { text, signature } = event.data;
                  // signature is the trailing Anthropic-style thinking-block
                  // signature; captured and applied to the thinking block on
                  // end (M1 acceptance: "with the trailing signature attached").
                  if (text || signature !== undefined) {
                    thinkingParser.emitReasoning(text ?? "", signature);
                  }
                }
                break;
              }
              case "contextUsage": {
                const pct = event.data.contextUsagePercentage;
                output.usage.input = Math.round((pct / 100) * (model.contextWindow ?? 0));
                // Pass through the raw percentage so rho-web (and other UIs)
                // can display it directly instead of back-calculating from
                // input tokens / guessed context window — which breaks when
                // the usage event later overwrites usage.input.
                (output.usage as unknown as Record<string, unknown>).contextPercent = pct;
                receivedContextUsage = true;
                break;
              }
              case "content": {
                const contentData = event.data;
                if (contentData === lastContentData) continue;
                lastContentData = contentData;
                totalContent += contentData;
                if (thinkingParser) {
                  // Close the native-reasoning block before the first content
                  // chunk so thinking_end is emitted before text_start (M1 fix).
                  // Idempotent — no-op after the first call.
                  thinkingParser.closeNativeReasoning();
                  thinkingParser.processChunk(contentData);
                } else {
                  if (textBlockIndex === null) {
                    textBlockIndex = output.content.length;
                    output.content.push({ type: "text", text: "" });
                    stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                  }
                  (output.content[textBlockIndex] as TextContent).text += contentData;
                  stream.push({
                    type: "text_delta",
                    contentIndex: textBlockIndex,
                    delta: contentData,
                    partial: output,
                  });
                }
                // Handle stopReason from content event (M2). Map Kiro's
                // "END_TURN" to OMP "stop"; preserve other values. The field
                // drives final turn-termination in the finalize step below.
                if (event.stopReason) {
                  parsedStopReason = event.stopReason === "END_TURN" ? "stop" : event.stopReason;
                }
                break;
              }
              case "toolUse": {
                const tc = event.data;
                sawAnyToolCalls = true;
                if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                  flushToolCall();
                  currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
                }
                currentToolCall.input += tc.input || "";
                if (tc.input) totalContent += tc.input;
                if (tc.stop) flushToolCall();
                break;
              }
              case "toolUseInput": {
                if (currentToolCall) currentToolCall.input += event.data.input || "";
                if (event.data.input) totalContent += event.data.input;
                break;
              }
              case "toolUseStop": {
                if (event.data.stop) flushToolCall();
                break;
              }
              case "usage": {
                usageEvent = event.data;
                break;
              }
              case "error": {
                const errMsg = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
                streamError = errMsg;
                void reader.cancel().catch(() => {});
                break;
              }
              // followupPrompt events are intentionally ignored
            }
            if (streamError) break;
          }
        }
        if (idleTimer) clearTimeout(idleTimer);
        if (firstTokenTimedOut || idleCancelled || streamError) {
          // Timed out or received error mid-stream: retry with backoff
          if (retryCount < maxRetries) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY);
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          if (streamError) {
            throw new Error(`Kiro API stream error after max retries: ${streamError}`);
          }
          throw new Error(`Kiro API error: ${firstTokenTimedOut ? "first token" : "idle"} timeout after max retries`);
        }
        if (currentToolCall && emitToolCall(currentToolCall, output, stream)) {
          emittedToolCalls++;
        }
        if (thinkingParser) {
          thinkingParser.finalize();
          textBlockIndex = thinkingParser.getTextBlockIndex();
        }
        // Fallback: extract bracket-style tool calls from content if no native tool calls
        if (!sawAnyToolCalls && textBlockIndex !== null) {
          const textBlock = output.content[textBlockIndex] as TextContent;
          const bracketResult = parseBracketToolCalls(textBlock.text);
          if (bracketResult.toolCalls.length > 0) {
            sawAnyToolCalls = true;
            textBlock.text = bracketResult.cleanedText;
            for (const btc of bracketResult.toolCalls) {
              if (
                emitToolCall(
                  {
                    toolUseId: btc.toolUseId,
                    name: btc.name,
                    input: JSON.stringify(btc.arguments),
                  },
                  output,
                  stream,
                )
              ) {
                emittedToolCalls++;
              }
            }
          }
        }
        // Strip echo noise: when tool calls are present and the text content
        // is just "." or similar short echo from history padding, remove it.
        // This prevents the echo from accumulating in conversation history
        // and reinforcing the pattern in future turns.
        if (emittedToolCalls > 0 && textBlockIndex !== null) {
          const textBlock = output.content[textBlockIndex] as TextContent;
          if (/^\s*(\.+|continue)\s*$/i.test(textBlock.text)) {
            textBlock.text = "";
          }
        }
        if (textBlockIndex !== null)
          stream.push({
            type: "text_end",
            contentIndex: textBlockIndex,
            content: (output.content[textBlockIndex] as TextContent).text,
            partial: output,
          });
        // The Kiro streaming API does not reliably emit per-response output
        // token counts (unlike Anthropic's `output_tokens` or Bedrock's
        // `usage.outputTokens`). When the `usage` event is missing or only
        // reports `inputTokens`, fall back to a tiktoken estimate over
        // everything the assistant emitted — text plus tool-call input JSON
        // (accumulated into `totalContent` above). Otherwise tool-call-only
        // turns report 0 output tokens and break consumers like the TPS
        // extension that watch `usage.output`.
        if (usageEvent?.inputTokens !== undefined) output.usage.input = usageEvent.inputTokens;
        output.usage.output = usageEvent?.outputTokens ?? countTokens(totalContent);
        output.usage.totalTokens = output.usage.input + output.usage.output;
        // All Kiro models are zero cost
        output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        // Detect degenerate responses: the API returned 200 but produced no
        // usable content at all — no text and no tool calls (not even broken
        // ones). This happens when the stream is truncated early or the API
        // returns only a contextUsage event. Retry with backoff.
        //
        // Also detect "Continue" echo loops: the model's entire response is
        // just "continue" (case-insensitive) with no tool calls. This happens
        // when synthetic history padding teaches the model to echo "Continue"
        // as a valid response, causing an infinite loop where pi sends
        // "continue" back and the model echoes it again.
        //
        // When tool calls *were* present but all got dropped (empty/unparseable
        // input), don't retry — the API did respond, it just sent malformed
        // tool calls. Retrying would likely produce the same result. The
        // stopReason fix below prevents the agent loop stall.
        const hasText = textBlockIndex !== null && (output.content[textBlockIndex] as TextContent).text.length > 0;
        const responseText = hasText ? (output.content[textBlockIndex as number] as TextContent).text : "";
        const isEchoLoop = hasText && !sawAnyToolCalls && /^\s*(continue|\.+)\s*$/i.test(responseText);
        if ((!hasText && !sawAnyToolCalls) || isEchoLoop) {
          if (retryCount < maxRetries) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY);
            console.warn(
              `[omp-provider-kiro] ${isEchoLoop ? 'Echo loop detected (model responded with just "Continue")' : "Empty response (no text, no tool calls)"} — retrying (${retryCount}/${maxRetries})`,
            );
            // Reset output content for the retry
            output.content = [];
            textBlockIndex = null;
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          if (isEchoLoop) {
            // After max retries, strip the echo text to prevent the agent
            // loop from interpreting "Continue" as a continuation signal.
            (output.content[textBlockIndex as number] as TextContent).text = "";
            console.warn(
              `[omp-provider-kiro] Echo loop persisted after ${maxRetries} retries — stripping "Continue" response`,
            );
          } else {
            console.warn(
              `[omp-provider-kiro] Empty response after ${maxRetries} retries — returning stopReason:"stop" to avoid agent loop stall`,
            );
          }
        }
        // Use emittedToolCalls (not toolCalls.length) to avoid stopReason:"toolUse"
        // when all tool calls were skipped due to empty/unparseable input — that
        // combination (empty content + toolUse stop) causes pi's agent loop to
        // stall waiting for tool results that will never arrive.
        // Honor a parsed Kiro stopReason (M2) when present; otherwise infer it.
        // Tool-call presence always wins: a parsed "stop"/"END_TURN" with tool
        // calls in the same turn must still terminate as "toolUse" so the agent
        // loop awaits results. The length heuristic only applies when no usage
        // event arrived and no tool calls were emitted.
        if (parsedStopReason && emittedToolCalls === 0) {
          output.stopReason = parsedStopReason as "stop" | "length" | "toolUse" | "error" | "aborted";
        } else if (!receivedContextUsage && emittedToolCalls === 0) {
          output.stopReason = "length";
        } else {
          output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
        }
        stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
        debugLog("response.done", {
          stopReason: output.stopReason,
          emittedToolCalls,
          sawAnyToolCalls,
          textLen: textBlockIndex !== null ? (output.content[textBlockIndex] as TextContent).text.length : 0,
          usage: output.usage,
          content: output.content,
        });
        stream.end();
        break;
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      debugLog("response.caught", { stopReason: output.stopReason, error: output.errorMessage });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    // Safety net: catch any rejection that escapes the inner try/catch
    // (e.g., AbortError during signal teardown). Without this, the
    // fire-and-forget IIFE produces an unhandled rejection that crashes pi.
    try {
      stream.end();
    } catch {}
  });
  return stream;
}
