/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuthClient } from 'google-auth-library';
import type { Config } from '../config/config.js';
import type { UserData } from '../code_assist/setup.js';
import {
  CodeAssistServer,
  type HttpOptions,
  type V1InternalBackend,
} from '../code_assist/server.js';
import { antigravityHeaders, endpointCandidates } from './client/client.js';

const REQUEST_TYPE_AGENT = 'agent';
const REQUEST_USER_AGENT = 'antigravity';

/**
 * Deterministic RFC 4122 UUID so a conversation keeps the same trajectory across
 * requests (and across restarts for the same session).
 */
function stableUuid(seed: string): string {
  const bytes = createHash('sha1').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Random int64 as a decimal string, matching Antigravity's request session id. */
function randomSessionId(): string {
  const bytes = randomBytes(8);
  return String(
    new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true),
  );
}

type GenerateEnvelope = {
  model?: string;
  request?: { contents?: unknown[] } & Record<string, unknown>;
};

/**
 * Builds Antigravity's request envelope and inner-request metadata.
 *
 * The trajectory, request id, and label set mirror what the Antigravity clients
 * put on the wire. They are not cosmetic: the backend reads them for routing and
 * experiment assignment, and a request that omits them is not always treated the
 * same as one that doesn't.
 */
export function createAntigravityEnvelope(sessionId?: string) {
  const seed = sessionId?.trim() || randomUUID();
  const trajectoryId = stableUuid(`antigravity:traj:session:${seed}`);
  const conversationId = stableUuid(`antigravity:conv:session:${seed}`);

  return (base: object): object => {
    const envelope = base as GenerateEnvelope;
    const contents = envelope.request?.contents ?? [];
    const step = Math.max(1, contents.length);
    const model = envelope.model ?? '';
    const isClaude = model.startsWith('claude-');
    const isNonGemini =
      isClaude || model.startsWith('gpt-oss-') || !model.startsWith('gemini-');
    const claudeLabel = isClaude ? 'true' : 'false';

    const labels: Record<string, string> = {
      last_step_index: String(Math.max(0, contents.length - 1)),
      request_id: `${trajectoryId}-${step - 1}`,
      trajectory_id: trajectoryId,
      used_claude: claudeLabel,
      used_claude_conservative: claudeLabel,
      used_non_gemini_model: isNonGemini ? 'true' : 'false',
    };
    // Antigravity only sends last_execution_id from the second turn onwards.
    if (step > 1) {
      labels['last_execution_id'] = stableUuid(
        `antigravity:exec:${trajectoryId}:${step - 1}`,
      );
    }

    return {
      ...envelope,
      requestType: REQUEST_TYPE_AGENT,
      userAgent: REQUEST_USER_AGENT,
      requestId: `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`,
      request: {
        ...envelope.request,
        sessionId: randomSessionId(),
        labels,
      },
    };
  };
}

/**
 * Antigravity speaks the same `v1internal` protocol as Gemini Code Assist
 * (Gemini Code Assist for individuals was retired on June 18, 2026 and consumer
 * traffic now runs through Antigravity), so request translation is shared. What
 * differs is the origin, the client fingerprint headers, and the envelope
 * fields Antigravity expects.
 */
export function antigravityBackend(sessionId?: string): V1InternalBackend {
  return {
    baseUrl: `${endpointCandidates()[0].replace(/\/+$/, '')}/v1internal`,
    headers: antigravityHeaders(undefined, { accept: 'text/event-stream' }),
    decorateGenerateRequest: createAntigravityEnvelope(sessionId),
  };
}

/**
 * Creates the content generator for a signed-in Antigravity user.
 */
export function createAntigravityServer(
  authClient: AuthClient,
  userData: UserData,
  httpOptions: HttpOptions = {},
  sessionId?: string,
  config?: Config,
): CodeAssistServer {
  return new CodeAssistServer(
    authClient,
    userData.projectId,
    httpOptions,
    sessionId,
    userData.userTier,
    userData.userTierName,
    userData.paidTier,
    config,
    antigravityBackend(sessionId ?? config?.getSessionId()),
  );
}
