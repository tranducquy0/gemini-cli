/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { AuthClient } from 'google-auth-library';
import type { Config } from '../config/config.js';
import type { UserData } from '../code_assist/setup.js';
import {
  CodeAssistServer,
  type HttpOptions,
  type V1InternalBackend,
} from '../code_assist/server.js';
import { antigravityHeaders, endpointCandidates } from './client/client.js';

/**
 * Antigravity speaks the same `v1internal` protocol as Gemini Code Assist
 * (Gemini Code Assist for individuals was retired on June 18, 2026 and consumer
 * traffic now runs through Antigravity), so request translation is shared. What
 * differs is the origin, the client fingerprint headers, and the envelope
 * fields Antigravity expects.
 */
export function antigravityBackend(): V1InternalBackend {
  return {
    baseUrl: `${endpointCandidates()[0].replace(/\/+$/, '')}/v1internal`,
    headers: antigravityHeaders(),
    decorateGenerateRequest: (request: object) => ({
      ...request,
      requestType: 'agent',
      userAgent: 'antigravity',
      requestId: `agent-${Date.now()}-${randomUUID()}`,
    }),
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
    antigravityBackend(),
  );
}
