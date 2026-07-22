import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getKiroApiKeyCredentials, getKiroCliCredentials } from "./kiro-cli.js";
import { fetchKiroModelCatalog } from "./management.js";
import { mapKiroModelCatalog } from "./model-discovery.js";
import { endpointForApiRegion } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";
import { fetchKiroUsage } from "./usage.js";

/**
 * M4: Credential cascade for OMP's `getCliCredentials` hook. Precedence:
 *   1. KIRO_API_KEY env var (paid-tier API key — highest, no DB/OAuth)
 *   2. kiro-cli SQLite DB (social / Builder ID / IdC)
 */
function resolveCliCredentials(): KiroCredentials | undefined {
  return getKiroApiKeyCredentials() ?? getKiroCliCredentials();
}

export default function ompKiroProvider(pi: ExtensionAPI) {
  const oauth = {
    name: "Kiro",
    login: loginKiro,
    refreshToken: refreshKiroToken,
    getApiKey: (cred: OAuthCredentials) => cred.access,
    // OMP 17 does not yet type these extension OAuth hooks, but preserves them
    // when registering the provider. Discovery also has its own safe fallback.
    getCliCredentials: resolveCliCredentials,
    fetchUsage: fetchKiroUsage,
  };

  pi.registerProvider("kiro", {
    baseUrl: endpointForApiRegion("us-east-1"),
    api: "kiro-api",
    fetchDynamicModels: async (apiKey) => mapKiroModelCatalog(await fetchKiroModelCatalog(apiKey)),
    oauth,
    streamSimple: streamKiro,
  });
}
