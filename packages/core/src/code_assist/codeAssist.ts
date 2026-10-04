/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, type ContentGenerator } from '../core/contentGenerator.js';
import { getOauthClient } from './oauth2.js';
import { setupUser } from './setup.js';
import { CodeAssistServer, type HttpOptions } from './server.js';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from '../core/loggingContentGenerator.js';
import { ModelMappingContentGenerator } from '../core/modelMappingContentGenerator.js';
import { getAntigravityOauthClient } from '../antigravity/auth/oauth.js';
import { setupAntigravityUser } from '../antigravity/auth/setup.js';
import { createAntigravityServer } from '../antigravity/server.js';

/**
 * Creates the content generator for OAuth-backed auth.
 *
 * "Sign in with Google" now signs in to Antigravity: Gemini Code Assist for
 * individuals was retired on June 18, 2026 and consumer accounts are served by
 * Antigravity, which speaks the same `v1internal` protocol. Application Default
 * Credentials (Cloud Shell / GCE) still talk to Gemini Code Assist directly.
 */
export async function createCodeAssistContentGenerator(
  httpOptions: HttpOptions,
  authType: AuthType,
  config: Config,
  sessionId?: string,
): Promise<ContentGenerator> {
  if (authType === AuthType.LOGIN_WITH_GOOGLE) {
    const authClient = await getAntigravityOauthClient(config);
    const userData = await setupAntigravityUser(config);
    return createAntigravityServer(
      authClient,
      userData,
      httpOptions,
      sessionId,
      config,
    );
  }

  if (authType === AuthType.COMPUTE_ADC) {
    const authClient = await getOauthClient(authType, config);
    const userData = await setupUser(authClient, config, httpOptions);
    return new CodeAssistServer(
      authClient,
      userData.projectId,
      httpOptions,
      sessionId,
      userData.userTier,
      userData.userTierName,
      userData.paidTier,
      config,
    );
  }

  throw new Error(`Unsupported authType: ${authType}`);
}

export function getCodeAssistServer(
  config: Config,
): CodeAssistServer | undefined {
  let server = config.getContentGenerator();

  // Recursively unwrap LoggingContentGenerator and ModelMappingContentGenerator
  while (true) {
    if (server instanceof LoggingContentGenerator) {
      server = server.getWrapped();
    } else if (server instanceof ModelMappingContentGenerator) {
      server = server.getWrapped();
    } else {
      break;
    }
  }

  if (!(server instanceof CodeAssistServer)) {
    return undefined;
  }
  return server;
}
