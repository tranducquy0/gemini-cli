/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '../../utils/debugLogger.js';
import { antigravityEnv } from '../utils/util.js';
import { isRecord, asString } from '../utils/util.js';

const DISCOVERY_TIMEOUT_MS = 8_000;

export const DEFAULT_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const PROD_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const ENDPOINT_FALLBACKS = [DEFAULT_ENDPOINT, PROD_ENDPOINT];

export const API_VERSION = 'v1internal';

export const ANTIGRAVITY_VERSION = '1.15.8';

/**
 * Endpoint override, e.g. for a local Antigravity gateway.
 *
 * The variables are namespaced on purpose: an unprefixed `BASE_URL`/`USER_AGENT`
 * is set by unrelated tooling and would silently redirect Antigravity traffic.
 * Nothing is required for Antigravity to work; these are optional overrides.
 */
export const BASE_URL_ENV_VAR = 'ANTIGRAVITY_BASE_URL';
export const USER_AGENT_ENV_VAR = 'ANTIGRAVITY_USER_AGENT';

/**
 * Consumers (Code Assist for individuals, Google AI Pro/Ultra) are served
 * exclusively by the `daily-cloudcode-pa` cluster; the `cloudcode-pa` cluster
 * only serves licensed/enterprise accounts. We keep it as a last-resort
 * fallback because workspace accounts are bound to it instead.
 */
export function endpointCandidates(): string[] {
  const explicit = antigravityEnv(BASE_URL_ENV_VAR)?.trim();
  return explicit ? [explicit] : ENDPOINT_FALLBACKS;
}

export function antigravityUserAgent(): string {
  const os =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  const arch =
    process.arch === 'x64'
      ? 'amd64'
      : process.arch === 'arm64'
        ? 'arm64'
        : process.arch;
  return (
    antigravityEnv(USER_AGENT_ENV_VAR) ||
    `antigravity/${ANTIGRAVITY_VERSION} ${os}/${arch}`
  );
}

/**
 * Client identity Antigravity expects on every request.
 *
 * The entitlement check on the backend keys off this metadata: a request
 * without it is not recognised as an Antigravity client and is rejected with
 * `SUBSCRIPTION_REQUIRED` even for accounts that have access.
 */
export function antigravityClientMetadata(): string {
  const platform =
    process.platform === 'win32'
      ? 'WINDOWS'
      : process.platform === 'darwin'
        ? 'MACOS'
        : 'LINUX';
  return JSON.stringify({
    ideType: 'ANTIGRAVITY',
    platform,
    pluginType: 'GEMINI',
  });
}

export function antigravityHeaders(
  token?: string,
  options: { accept?: string } = {},
): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
    ...(options.accept ? { Accept: options.accept } : {}),
    'User-Agent': antigravityUserAgent(),
    'X-Goog-Api-Client': 'antigravity-cli',
    'Client-Metadata': antigravityClientMetadata(),
  };
}

export function antigravityMethodUrl(endpoint: string, method: string): string {
  return `${endpoint}/${API_VERSION}:${method}`;
}

export async function antigravityFetch(url: string, options: RequestInit) {
  // Resolved per call so tests (and proxies installed after startup) can swap
  // the global fetch implementation.
  return globalThis.fetch(url, options);
}

export type AntigravityApiKey = {
  token: string;
  projectId: string;
};

export function parseApiKey(apiKeyRaw: string | undefined): AntigravityApiKey {
  if (!apiKeyRaw) {
    throw new Error(
      'No Antigravity OAuth credentials. Run /login antigravity.',
    );
  }

  try {
    const parsed: unknown = JSON.parse(apiKeyRaw);
    if (!isRecord(parsed)) throw new Error('credentials must be a JSON object');
    const token = asString(parsed['token']);
    const projectId = asString(parsed['projectId']);
    if (!token || !projectId) throw new Error('missing token or projectId');
    return { token, projectId };
  } catch (error) {
    throw new Error(
      `Invalid Antigravity credentials. Run /login antigravity.`,
      {
        cause: error,
      },
    );
  }
}

/**
 * The subset of `v1internal:loadCodeAssist` that Gemini CLI cares about: the
 * project every request is billed/attributed to plus the user's plan.
 */
export type AntigravityAccount = {
  projectId?: string;
  tierId?: string;
  tierName?: string;
  paidTierId?: string;
  paidTierName?: string;
};

export function extractAccount(data: unknown): AntigravityAccount | undefined {
  if (!isRecord(data)) return undefined;

  const currentTier = isRecord(data['currentTier'])
    ? data['currentTier']
    : undefined;
  const paidTier = isRecord(data['paidTier']) ? data['paidTier'] : undefined;

  const account: AntigravityAccount = {};
  const projectId = extractProjectId(data);
  if (projectId) account.projectId = projectId;

  const tierId = asString(currentTier?.['id']);
  if (tierId) account.tierId = tierId;
  const tierName = asString(currentTier?.['name']);
  if (tierName) account.tierName = tierName;

  const paidTierId = asString(paidTier?.['id']);
  if (paidTierId) account.paidTierId = paidTierId;
  const paidTierName = asString(paidTier?.['name']);
  if (paidTierName) account.paidTierName = paidTierName;

  return Object.keys(account).length > 0 ? account : undefined;
}

export function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;

  const direct =
    data['antigravityProjectId'] ??
    data['projectId'] ??
    data['backendProjectId'] ??
    data['userDefinedCloudaicompanionProject'] ??
    data['cloudaicompanionProject'] ??
    data['project'];
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct['id']);
    if (nestedId) return nestedId;
  }

  for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
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
        antigravityMethodUrl(endpoint, 'listCloudAICompanionProjects'),
        {
          method: 'POST',
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

export async function fetchAvailableModelsCatalog(
  token: string,
  projectId: string,
) {
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(
        antigravityMethodUrl(endpoint, 'fetchAvailableModels'),
        {
          method: 'POST',
          headers: antigravityHeaders(token),
          body: JSON.stringify({ project: projectId }),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        },
      );
      if (!res.ok) continue;
      const data = await res.json();
      return { endpoint, status: res.status, data };
    } catch (error) {
      debugLogger.error(`Failed to fetch models from ${endpoint}`, error);
    }
  }
  throw new Error('Failed to fetch models catalog from all endpoints');
}

/**
 * Resolves the Antigravity account (project + plan) for an access token.
 *
 * Antigravity provisions the consumer project on first use, so `loadCodeAssist`
 * normally returns it right away; `listCloudAICompanionProjects` is only a
 * fallback for responses that omit it.
 */
export async function fetchAntigravityAccount(
  token: string,
): Promise<AntigravityAccount | undefined> {
  let lastError: unknown;
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(
        antigravityMethodUrl(endpoint, 'loadCodeAssist'),
        {
          method: 'POST',
          headers: antigravityHeaders(token),
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        lastError = new Error(`${endpoint} responded with HTTP ${res.status}`);
        debugLogger.warn(
          `Antigravity loadCodeAssist ${endpoint} -> HTTP ${res.status}`,
        );
        continue;
      }
      const data: unknown = await res.json();
      const account = extractAccount(data);
      debugLogger.log(describeAccountResponse(endpoint, account, data));
      if (account?.projectId) return account;
      const projectId = await listCloudAICompanionProjects(token);
      return projectId ? { ...account, projectId } : account;
    } catch (error) {
      lastError = error;
      debugLogger.error(`Failed to load code assist from ${endpoint}`, error);
    }
  }
  debugLogger.warn('Failed to resolve Antigravity account', lastError);
  return undefined;
}

export async function loadCodeAssist(token: string) {
  return (await fetchAntigravityAccount(token))?.projectId;
}

/**
 * Summarizes a `loadCodeAssist` response for the debug log.
 *
 * The entitlement on the account decides whether generate requests are served
 * at all (`403 SUBSCRIPTION_REQUIRED`), so log the plan fields and the shape of
 * the payload. Only field names and plan identifiers are logged, never tokens
 * or account identifiers.
 */
export function describeAccountResponse(
  endpoint: string,
  account: AntigravityAccount | undefined,
  data: unknown,
): string {
  const keys = isRecord(data) ? Object.keys(data).sort().join(',') : 'n/a';
  const gcpManaged = isRecord(data)
    ? String(data['gcpManaged'] ?? 'unknown')
    : 'unknown';
  return (
    `Antigravity loadCodeAssist ${endpoint} -> project=${account?.projectId ?? 'none'}` +
    ` tier=${account?.tierId ?? 'none'}(${account?.tierName ?? '?'})` +
    ` paidTier=${account?.paidTierId ?? 'none'}(${account?.paidTierName ?? '?'})` +
    ` gcpManaged=${gcpManaged} fields=[${keys}]`
  );
}
