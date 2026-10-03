import { debugLogger } from "../../utils/debugLogger.js";
import { antigravityEnv } from "../utils/util.js";
import { isRecord, asString } from "../utils/util.js";

const fetch = globalThis.fetch;
const DISCOVERY_TIMEOUT_MS = 8_000;

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

export async function antigravityFetch(url: string, options: RequestInit) {
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
    "User-Agent": antigravityEnv("USER_AGENT") || "antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; auth_method=consumer)",
    "X-Goog-Api-Client": "antigravity-cli",
  };
}

export type AntigravityApiKey = {
  token: string;
  projectId: string;
};

export function parseApiKey(apiKeyRaw: string | undefined): AntigravityApiKey {
  if (!apiKeyRaw) {
    throw new Error("No Antigravity OAuth credentials. Run /login antigravity.");
  }

  try {
    const parsed: unknown = JSON.parse(apiKeyRaw);
    if (!isRecord(parsed)) throw new Error("credentials must be a JSON object");
    const token = asString(parsed["token"]);
    const projectId = asString(parsed["projectId"]);
    if (!token || !projectId) throw new Error("missing token or projectId");
    return { token, projectId };
  } catch (error) {
    throw new Error(`Invalid Antigravity credentials. Run /login antigravity.`, {
      cause: error,
    });
  }
}

export function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;

  const direct =
    data["antigravityProjectId"] ??
    data["projectId"] ??
    data["backendProjectId"] ??
    data["userDefinedCloudaicompanionProject"] ??
    data["cloudaicompanionProject"] ??
    data["project"];
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct["id"]);
    if (nestedId) return nestedId;
  }

  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const nested = extractProjectId(item) ?? asString(item);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function listCloudAICompanionProjects(
  token: string,
): Promise<string | undefined> {
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(
        `${endpoint}/v1internal:listCloudAICompanionProjects`,
        {
          method: "POST",
          headers: antigravityHeaders(token),
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        },
      );
      if (res.ok) return extractProjectId(await res.json());
    } catch (error) {
      debugLogger.error(`Failed to list projects from ${endpoint}`, error);
    }
  }
  return undefined;
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
      return extractProjectId(data) ?? (await listCloudAICompanionProjects(token));
    } catch (error) {
      debugLogger.error(`Failed to load code assist from ${endpoint}`, error);
    }
  }
  return undefined;
}
