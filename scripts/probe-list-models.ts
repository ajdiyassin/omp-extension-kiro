// ABOUTME: Captures a fail-closed, identity-free Kiro ListAvailableModels fixture.
// ABOUTME: Uses the extension credential cascade but never logs or writes credential/request data.

import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getKiroApiKeyCredentials,
  getKiroCliCredentials,
  getKiroCliSocialToken,
} from "../src/kiro-cli.js";
import {
  extractRegionFromProfileArn,
  managementEndpointForApiRegion,
  resolveApiRegion,
} from "../src/models.js";
import {
  assertSanitizedFixtureSafe,
  sanitizeListAvailableModelsResponse,
  type SanitizedListAvailableModelsResponse,
} from "../src/model-discovery-fixture.js";
import type { KiroCredentials } from "../src/oauth.js";

const DEFAULT_OUTPUT = "test/fixtures/kiro-list-available-models-2.13.1.json";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

type CredentialKind = SanitizedListAvailableModelsResponse["source"]["credentialKind"];

interface ProbeCredential {
  credentials: KiroCredentials;
  kind: CredentialKind;
}

function resolveProbeCredential(): ProbeCredential {
  const apiKey = getKiroApiKeyCredentials();
  if (apiKey) return { credentials: apiKey, kind: "api-key" };

  const valid = getKiroCliSocialToken() ?? getKiroCliCredentials();
  if (!valid) {
    throw new Error("credential-resolution:no-valid-token; refresh with kiro-cli or OMP, then rerun");
  }
  return {
    credentials: valid,
    kind: valid.authMethod === "desktop" ? "oauth-desktop" : "oauth-idc",
  };
}

function detectKiroCliVersion(): string {
  const output = execFileSync("kiro-cli", ["--version"], {
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  if (!match?.[1]) throw new Error("client-version:unrecognized");
  return match[1];
}

function writeFixtureAtomically(path: string, fixture: SanitizedListAvailableModelsResponse): void {
  assertSanitizedFixtureSafe(fixture);
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  const output = resolve(path);
  const temporary = `${output}.tmp-${process.pid}`;
  mkdirSync(dirname(output), { recursive: true });
  try {
    writeFileSync(temporary, serialized, { encoding: "utf-8", flag: "wx" });
    rmSync(output, { force: true });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
}

type ApiRegion = "us-east-1" | "eu-central-1";

interface ProbeRoute {
  apiRegion: ApiRegion;
  profileArn?: string;
}

async function readBoundedJson(response: Response, operation: string, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`${operation}:response-size`);
  try {
    return JSON.parse(bytes.toString("utf-8")) as unknown;
  } catch {
    throw new Error(`${operation}:invalid-json`);
  }
}

function validatedProfileRoute(profileArn: string): ProbeRoute | undefined {
  if (!/^arn:aws:codewhisperer:[a-z0-9-]+:[0-9]+:profile\/[A-Za-z0-9_-]+$/.test(profileArn)) return undefined;
  const region = extractRegionFromProfileArn(profileArn);
  if (region !== "us-east-1" && region !== "eu-central-1") return undefined;
  return { apiRegion: region, profileArn };
}

async function resolveProbeRoute(credentials: KiroCredentials, kind: CredentialKind): Promise<ProbeRoute> {
  if (kind === "api-key") return { apiRegion: "us-east-1" };
  if (credentials.profileArn) {
    const route = validatedProfileRoute(credentials.profileArn);
    if (route) return route;
  }

  const credentialRegion = resolveApiRegion(credentials.region);
  const candidates = [...new Set([credentialRegion, "us-east-1", "eu-central-1"])].filter(
    (region): region is ApiRegion => region === "us-east-1" || region === "eu-central-1",
  );
  const statuses: number[] = [];
  for (const region of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(managementEndpointForApiRegion(region), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          Authorization: `Bearer ${credentials.access}`,
          "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
        },
        body: "{}",
        signal: controller.signal,
      });
      if (!response.ok) {
        statuses.push(response.status);
        continue;
      }
      const value = await readBoundedJson(response, "list-profiles", 128 * 1024);
      if (typeof value !== "object" || value === null || !("profiles" in value)) continue;
      const profiles = (value as { profiles?: unknown }).profiles;
      if (!Array.isArray(profiles)) continue;
      for (const profile of profiles) {
        if (typeof profile !== "object" || profile === null) continue;
        const arn = (profile as { arn?: unknown }).arn;
        if (typeof arn !== "string") continue;
        const route = validatedProfileRoute(arn);
        if (route) return route;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  const statusCode = statuses.length > 0 ? [...new Set(statuses)].join(",") : "no-profile";
  throw new Error(`profile-resolution:${statusCode}`);
}

async function fetchRawModels(
  credentials: KiroCredentials,
  apiRegion: ApiRegion,
  profileArn?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body = profileArn ? { origin: "KIRO_CLI", profileArn } : { origin: "KIRO_CLI" };
    const response = await fetch(managementEndpointForApiRegion(apiRegion), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Authorization: `Bearer ${credentials.access}`,
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`list-models:http-${response.status}`);
    return readBoundedJson(response, "list-models");
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const output = process.argv[2] || DEFAULT_OUTPUT;
  const clientVersion = detectKiroCliVersion();
  const { credentials, kind } = resolveProbeCredential();
  const route = await resolveProbeRoute(credentials, kind);
  const raw = await fetchRawModels(credentials, route.apiRegion, route.profileArn);
  const fixture = sanitizeListAvailableModelsResponse(raw, {
    client: "kiro-cli",
    clientVersion,
    operation: "ListAvailableModels",
    apiRegion: route.apiRegion,
    credentialKind: kind,
    capturedAt: new Date().toISOString(),
  });
  writeFixtureAtomically(output, fixture);
  console.log(`Captured ${fixture.models.length} sanitized models (${kind}, ${route.apiRegion})`);
  console.log(`Fixture: ${output}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  console.error(`ListAvailableModels probe failed: ${message}`);
  process.exitCode = 1;
});
