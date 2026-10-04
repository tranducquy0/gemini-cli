/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { UserData } from '../../code_assist/setup.js';
import { UserTierId } from '../../code_assist/types.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { resolveAntigravitySession } from './oauth.js';
import { endpointCandidates } from '../client/client.js';

/**
 * Signs the user in to Antigravity and returns the account data the rest of the
 * CLI expects from `setupUser` (project ID plus the plan used for quota and
 * billing decisions).
 *
 * Unlike Gemini Code Assist there is nothing to onboard: Antigravity
 * provisions the consumer project on the account's first request and returns it
 * from `loadCodeAssist`.
 */
export async function setupAntigravityUser(config: Config): Promise<UserData> {
  const { account } = await resolveAntigravitySession(config);

  const projectId = account.projectId!;
  const userTier = account.paidTierId ?? account.tierId ?? UserTierId.STANDARD;
  debugLogger.log(
    `Antigravity account ready (project=${projectId}, tier=${userTier}, ` +
      `tierName=${account.paidTierName ?? account.tierName ?? 'unknown'}, ` +
      `endpoint=${endpointCandidates()[0]})`,
  );

  return {
    projectId,
    userTier,
    userTierName: account.paidTierName ?? account.tierName,
    paidTier: account.paidTierId
      ? {
          id: account.paidTierId,
          name: account.paidTierName,
          userDefinedCloudaicompanionProject: false,
        }
      : undefined,
  };
}
