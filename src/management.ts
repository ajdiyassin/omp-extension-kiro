// ABOUTME: Calls Kiro's management API for profile-aware native model discovery.
// ABOUTME: Keeps bearer/profile data in memory and returns only a sanitized model catalog.

import { readAuthMeta } from "./auth-meta.js";
import {
  getKiroApiKeyCredentials,
  getKiroCliCredentials,
  getKiroCliCredentialsAllowExpired,
  getKiroCliSocialToken,
} from "./kiro-cli.js";
import { type SanitizedKiroModelCatalog, sanitizeKiroModelCatalog } from "./model-discovery-fixture.js";
import { managementEndpointForApiRegion, resolveApiRegion } from "./models.js";
import type { KiroCredentials } from "./oauth.js";

export type KiroApiRegion = string;
export type KiroManagementCredentialKind = "api-key" | "oauth-idc" | "oauth-desktop";

export interface KiroManagementCredential {
  accessToken: string;
  kind: KiroManagementCredentialKind;
  region?: string;
  profileArn?: string;
}

export interface KiroManagementRoute {
  apiRegion: KiroApiRegion;
  profileArn?: string;
}

type FetchLike = typeof fetch;

const PROFILE_DISCOVERY_SEED_REGIONS = ["us-east-1", "eu-central-1"] as const;
const MAX_MANAGEMENT_RESPONSE_BYTES = 1024 * 1024;
const MANAGEMENT_TIMEOUT_MS = 10_000;
const PROFILE_ARN = /^arn:aws:codewhisperer:([a-z0-9-]+):[0-9]+:profile\/[A-Za-z0-9_-]+$/;

function asApiRegion(region: string | undefined): KiroApiRegion | undefined {
  if (!region) return undefined;
  const resolved = resolveApiRegion(region);
  return /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(resolved) ? resolved : undefined;
}

function credentialKind(credentials: KiroCredentials): KiroManagementCredentialKind {
  return credentials.authMethod === "desktop" ? "oauth-desktop" : "oauth-idc";
}

function matchingCliCredential(accessToken: string): KiroCredentials | undefined {
  const valid = getKiroCliSocialToken() ?? getKiroCliCredentials();
  if (valid?.access === accessToken) return valid;
  const expired = getKiroCliCredentialsAllowExpired();
  return expired?.access === accessToken ? expired : undefined;
}

/** Resolve the bearer and non-secret routing hints used by dynamic discovery. */
export function resolveKiroManagementCredential(apiKey: string | undefined): KiroManagementCredential {
  const envCredentials = getKiroApiKeyCredentials();
  if (apiKey && envCredentials?.access === apiKey) {
    return {
      accessToken: apiKey,
      kind: "api-key",
      region: process.env.KIRO_API_REGION ?? envCredentials.region,
    };
  }
  if (apiKey) {
    const matching = matchingCliCredential(apiKey);
    const cached = readAuthMeta(apiKey);
    return {
      accessToken: apiKey,
      kind: matching ? credentialKind(matching) : "oauth-idc",
      region: process.env.KIRO_API_REGION ?? cached?.apiRegion ?? matching?.region,
      profileArn: matching?.profileArn ?? cached?.profileArn,
    };
  }
  if (envCredentials) {
    return {
      accessToken: envCredentials.access,
      kind: "api-key",
      region: process.env.KIRO_API_REGION ?? envCredentials.region,
    };
  }
  const cliCredentials = getKiroCliSocialToken() ?? getKiroCliCredentials();
  if (!cliCredentials) {
    throw new Error("Kiro model discovery requires /login kiro, a valid Kiro CLI session, or KIRO_API_KEY");
  }
  return {
    accessToken: cliCredentials.access,
    kind: credentialKind(cliCredentials),
    region: process.env.KIRO_API_REGION ?? cliCredentials.region,
    profileArn: cliCredentials.profileArn,
  };
}

function routeFromProfileArn(profileArn: unknown): KiroManagementRoute | undefined {
  if (typeof profileArn !== "string") return undefined;
  const match = profileArn.match(PROFILE_ARN);
  if (!match) return undefined;
  const apiRegion = asApiRegion(match[1]);
  return apiRegion ? { apiRegion, profileArn } : undefined;
}

async function readBoundedJson(response: Response, operation: string, maxBytes = MAX_MANAGEMENT_RESPONSE_BYTES) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new Error(`${operation}: invalid response size`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${operation}: missing response body`);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${operation}: invalid response size`);
    }
    chunks.push(value);
  }
  if (totalBytes === 0) throw new Error(`${operation}: invalid response size`);

  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf-8")) as unknown;
  } catch {
    throw new Error(`${operation}: invalid JSON`);
  }
}

async function managementRequest(
  fetchImpl: FetchLike,
  apiRegion: KiroApiRegion,
  accessToken: string,
  target: "ListAvailableProfiles" | "ListAvailableModels",
  body: unknown,
  maxBytes?: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANAGEMENT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(managementEndpointForApiRegion(apiRegion), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Authorization: `Bearer ${accessToken}`,
        "X-Amz-Target": `AmazonCodeWhispererService.${target}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${target}: HTTP ${response.status}`);
    return await readBoundedJson(response, target, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

/** Resolve OAuth management routing from an in-memory profile ARN or ListAvailableProfiles. */
export async function resolveKiroManagementRoute(
  credential: KiroManagementCredential,
  fetchImpl: FetchLike = fetch,
): Promise<KiroManagementRoute> {
  if (credential.kind === "api-key") {
    return { apiRegion: asApiRegion(credential.region) ?? "us-east-1" };
  }
  const knownProfile = routeFromProfileArn(credential.profileArn);
  if (knownProfile) return knownProfile;

  const preferred = asApiRegion(credential.region);
  const candidates = [
    ...new Set([preferred, ...PROFILE_DISCOVERY_SEED_REGIONS].filter((region): region is string => !!region)),
  ];
  let lastError: Error | undefined;
  for (const apiRegion of candidates) {
    try {
      const value = await managementRequest(
        fetchImpl,
        apiRegion,
        credential.accessToken,
        "ListAvailableProfiles",
        {},
        128 * 1024,
      );
      if (typeof value !== "object" || value === null || !("profiles" in value)) continue;
      const profiles = (value as { profiles?: unknown }).profiles;
      if (!Array.isArray(profiles) || profiles.length > 128) continue;
      for (const profile of profiles) {
        if (typeof profile !== "object" || profile === null) continue;
        const route = routeFromProfileArn((profile as { arn?: unknown }).arn);
        if (route) return route;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("ListAvailableProfiles: no routable Kiro profile returned");
}

/** Fetch and fail-closed sanitize the authoritative Kiro model catalog. */
export async function fetchKiroModelCatalog(
  apiKey: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<SanitizedKiroModelCatalog> {
  const credential = resolveKiroManagementCredential(apiKey);
  const route = await resolveKiroManagementRoute(credential, fetchImpl);
  const value = await managementRequest(
    fetchImpl,
    route.apiRegion,
    credential.accessToken,
    "ListAvailableModels",
    route.profileArn ? { origin: "KIRO_CLI", profileArn: route.profileArn } : { origin: "KIRO_CLI" },
  );
  return sanitizeKiroModelCatalog(value);
}
