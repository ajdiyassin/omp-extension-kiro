// ABOUTME: Forces one Kiro CLI OAuth refresh and verifies the selected profile still routes discovery.
// ABOUTME: Prints only booleans, counts, and HTTP statuses; never credential or profile values.

import {
  resolveKiroManagementRoute,
} from "../src/management.js";
import {
  getKiroCliCredentialsAllowExpired,
} from "../src/kiro-cli.js";
import {
  forceRefreshKiroToken,
  type KiroCredentials,
} from "../src/oauth.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PROFILE_ARN_PATTERN = /^arn:aws:codewhisperer:([a-z0-9-]+):[0-9]+:profile\/[A-Za-z0-9_-]+$/;

interface ProfilesResponse {
  profiles?: Array<{ arn?: unknown }>;
}

function profileRegion(profileArn: string): string {
  const region = PROFILE_ARN_PATTERN.exec(profileArn)?.[1];
  if (!region) throw new Error("Stored Kiro profile ARN is malformed");
  return region;
}

async function postManagement(
  token: string,
  region: string,
  target: string,
  body: unknown,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`https://management.${region}.kiro.dev/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": target,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedJson(response: Response, operation: string): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(`${operation} returned an invalid response size`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function parseProfiles(value: unknown): ProfilesResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ListAvailableProfiles returned an invalid response");
  }
  const profiles = (value as ProfilesResponse).profiles;
  if (profiles !== undefined && !Array.isArray(profiles)) {
    throw new Error("ListAvailableProfiles returned an invalid profiles collection");
  }
  return { profiles };
}

async function main(): Promise<void> {
  const stored = getKiroCliCredentialsAllowExpired();
  if (!stored?.access || !stored.refresh) {
    throw new Error("No refreshable Kiro CLI OAuth credential was found; run kiro-cli login first");
  }

  const route = await resolveKiroManagementRoute({
    accessToken: stored.access,
    kind: stored.authMethod === "desktop" ? "oauth-desktop" : "oauth-idc",
    region: stored.region,
    profileArn: stored.profileArn,
  });
  if (!route.profileArn) throw new Error("Kiro profile discovery returned no selected profile");
  const beforeProfile = route.profileArn;
  const region = profileRegion(beforeProfile);
  const before: KiroCredentials = { ...stored, profileArn: beforeProfile, region };
  const refreshed = (await forceRefreshKiroToken(before)) as KiroCredentials;
  if (!refreshed.access || !refreshed.refresh) throw new Error("Kiro refresh returned incomplete credentials");

  const profilesResponse = await postManagement(
    refreshed.access,
    region,
    "AmazonCodeWhispererService.ListAvailableProfiles",
    { maxResults: 10 },
  );
  if (!profilesResponse.ok) {
    await profilesResponse.arrayBuffer();
    throw new Error(`ListAvailableProfiles failed with HTTP ${profilesResponse.status}`);
  }
  const profiles = parseProfiles(await readBoundedJson(profilesResponse, "ListAvailableProfiles"));
  const profileStillAvailable =
    profiles.profiles?.some(profile => profile.arn === beforeProfile) ?? false;

  const modelsResponse = await postManagement(
    refreshed.access,
    region,
    "AmazonCodeWhispererService.ListAvailableModels",
    { origin: "KIRO_CLI", profileArn: beforeProfile },
  );
  const modelsStatus = modelsResponse.status;
  await modelsResponse.arrayBuffer();

  const result = {
    refreshSucceeded: true,
    profilePreservedByRefresh: refreshed.profileArn === beforeProfile,
    profileReturnedByRefresh: typeof refreshed.profileArn === "string",
    profileStillAvailable,
    profilesReturned: profiles.profiles?.length ?? 0,
    profilesStatus: profilesResponse.status,
    modelsStatus,
  };
  console.log(JSON.stringify(result, null, 2));

  if (!result.profilePreservedByRefresh || modelsStatus !== 200) {
    throw new Error("Refresh did not preserve a working selected profile");
  }
}

await main();
