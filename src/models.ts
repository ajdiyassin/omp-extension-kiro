// ABOUTME: Kiro runtime/management endpoint routing and narrow legacy model aliases.
// ABOUTME: Live model availability and capabilities come exclusively from dynamic discovery.

/** Map an SSO/OIDC region to one of Kiro's management/runtime API regions. */
const API_REGION_MAP: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-south-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
};

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
}

export function endpointForApiRegion(apiRegion: string): string {
  return `https://runtime.${apiRegion}.kiro.dev/`;
}

export function managementEndpointForApiRegion(apiRegion: string): string {
  return `https://management.${apiRegion}.kiro.dev/`;
}

export function extractRegionFromEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    const hostname = new URL(endpoint).hostname;
    const parts = hostname.split(".");
    if ((parts[0] === "runtime" || parts[0] === "management") && parts[1]) return parts[1];
    // Preserve auth metadata written by versions that used q.{region}.amazonaws.com.
    if (parts[0] === "q" && parts[1]) return parts[1];
  } catch {
    return undefined;
  }
  return undefined;
}

export function extractRegionFromProfileArn(profileArn: string | undefined): string | undefined {
  if (!profileArn) return undefined;
  const parts = profileArn.split(":");
  return parts[0] === "arn" && parts.length > 3 && parts[3] ? parts[3] : undefined;
}

/**
 * Explicit compatibility for selectors emitted by pre-dynamic releases.
 * Never infer version punctuation: IDs such as gpt-5.6-sol must pass through unchanged.
 */
const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "claude-opus-4-8": "claude-opus-4.8",
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "deepseek-3-2": "deepseek-3.2",
  "minimax-m2-5": "minimax-m2.5",
  "minimax-m2-1": "minimax-m2.1",
});

export function resolveKiroModel(modelId: string): string {
  return LEGACY_MODEL_ALIASES[modelId] ?? modelId;
}
