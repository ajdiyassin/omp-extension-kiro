// ABOUTME: Sends one deliberately malformed Kiro runtime request to capture the provider error contract.
// ABOUTME: Prints only response metadata and EventStream header types; never credentials, profile data, or payloads.

import { randomUUID } from "node:crypto";
import {
  resolveKiroManagementRoute,
} from "../src/management.js";
import {
  getKiroCliCredentials,
  getKiroCliSocialToken,
} from "../src/kiro-cli.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PROFILE_ARN_PATTERN = /^arn:aws:codewhisperer:([a-z0-9-]+):[0-9]+:profile\/[A-Za-z0-9_-]+$/;

interface FrameSummary {
  frames: number;
  messageTypes: string[];
  eventTypes: string[];
  exceptionTypes: string[];
  framingComplete: boolean;
}

function profileRegion(profileArn: string): string {
  const region = PROFILE_ARN_PATTERN.exec(profileArn)?.[1];
  if (!region) throw new Error("Stored Kiro profile ARN is malformed");
  return region;
}

function summarizeEventStream(bytes: Uint8Array): FrameSummary {
  const messageTypes = new Set<string>();
  const eventTypes = new Set<string>();
  const exceptionTypes = new Set<string>();
  let frames = 0;
  let offset = 0;

  while (offset < bytes.length) {
    if (bytes.length - offset < 16) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);
    if (totalLength < 16 || totalLength > bytes.length - offset || headersLength > totalLength - 16) break;

    const frame = bytes.subarray(offset, offset + totalLength);
    let cursor = 12;
    const headersEnd = 12 + headersLength;
    const headers = new Map<string, string>();
    while (cursor < headersEnd) {
      const nameLength = frame[cursor++];
      if (cursor + nameLength + 1 > headersEnd) break;
      const name = new TextDecoder().decode(frame.subarray(cursor, cursor + nameLength));
      cursor += nameLength;
      const type = frame[cursor++];
      if (type !== 7 || cursor + 2 > headersEnd) break;
      const valueLength = new DataView(frame.buffer, frame.byteOffset + cursor, 2).getUint16(0, false);
      cursor += 2;
      if (cursor + valueLength > headersEnd) break;
      const value = new TextDecoder().decode(frame.subarray(cursor, cursor + valueLength));
      cursor += valueLength;
      headers.set(name, value);
    }
    if (cursor !== headersEnd) break;

    const messageType = headers.get(":message-type");
    const eventType = headers.get(":event-type");
    const exceptionType = headers.get(":exception-type");
    if (messageType) messageTypes.add(messageType);
    if (eventType) eventTypes.add(eventType);
    if (exceptionType) exceptionTypes.add(exceptionType);
    frames += 1;
    offset += totalLength;
  }

  return {
    frames,
    messageTypes: [...messageTypes].sort(),
    eventTypes: [...eventTypes].sort(),
    exceptionTypes: [...exceptionTypes].sort(),
    framingComplete: offset === bytes.length,
  };
}

async function main(): Promise<void> {
  const credentials = getKiroCliSocialToken() ?? getKiroCliCredentials();
  if (!credentials?.access) {
    throw new Error("No valid Kiro OAuth credential was found; log in again first");
  }
  const route = await resolveKiroManagementRoute({
    accessToken: credentials.access,
    kind: credentials.authMethod === "desktop" ? "oauth-desktop" : "oauth-idc",
    region: credentials.region,
    profileArn: credentials.profileArn,
  });
  if (!route.profileArn) throw new Error("Kiro profile discovery returned no selected profile");
  const profileArn = route.profileArn;
  const region = profileRegion(profileArn);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`https://runtime.${region}.kiro.dev/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/vnd.amazon.eventstream",
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
        "x-amzn-codewhisperer-optout": "false",
        "amz-sdk-invocation-id": randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
        "User-Agent": "omp-kiro-phase0-probe",
      },
      body: JSON.stringify({
        conversationState: {},
        profileArn,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw new Error("Kiro exception response exceeded the probe limit");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0] ?? null;
  const stream = contentType === "application/vnd.amazon.eventstream" ? summarizeEventStream(bytes) : null;

  console.log(JSON.stringify({
    status: response.status,
    contentType,
    responseBytes: bytes.length,
    eventStream: stream,
  }, null, 2));
}

await main();
