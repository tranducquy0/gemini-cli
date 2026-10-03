import { debugLogger } from "../../utils/debugLogger.js";
import { antigravityEnv } from "../utils/util.js";
import { isRecord, asString } from "../utils/util.js";

const fetch = globalThis.fetch; 

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

export async function antigravityFetch(url: string, options: RequestInit) {
  // TODO: Integrate Gemini CLI proxy settings
  return fetch(url, options);
}

export function endpointCandidates(): string[] {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  return explicit ? [explicit] : ENDPOINT_FALLBACKS;
}

export function antigravityHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function fetchAvailableModelsCatalog(token: string, projectId: string) {
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({ project: projectId }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      return { endpoint, status: res.status, data };
    } catch (error) {
      debugLogger.error(`Failed to fetch models from ${endpoint}`, error);
    }
  }
  throw new Error("Failed to fetch models catalog from all endpoints");
}

export async function loadCodeAssist(token: string) {
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      // Simple project ID extraction
      return asString(isRecord(data) ? data.projectId : undefined);
    } catch (error) {
      debugLogger.error(`Failed to load code assist from ${endpoint}`, error);
    }
  }
  return undefined;
}
