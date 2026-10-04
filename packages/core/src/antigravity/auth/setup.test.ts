/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../config/config.js';
import { UserTierId } from '../../code_assist/types.js';
import { setupAntigravityUser } from './setup.js';
import { resolveAntigravitySession } from './oauth.js';

vi.mock('./oauth.js');

const mockedResolveAntigravitySession = vi.mocked(resolveAntigravitySession);
const mockConfig = {} as Config;

describe('antigravity/auth/setup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the discovered project and free tier', async () => {
    mockedResolveAntigravitySession.mockResolvedValue({
      token: 'token',
      account: {
        projectId: 'antigravity-project',
        tierId: UserTierId.FREE,
        tierName: 'Antigravity',
      },
    });

    await expect(setupAntigravityUser(mockConfig)).resolves.toEqual({
      projectId: 'antigravity-project',
      userTier: UserTierId.FREE,
      userTierName: 'Antigravity',
      paidTier: undefined,
    });
  });

  it('prefers the paid tier when the account has one', async () => {
    mockedResolveAntigravitySession.mockResolvedValue({
      token: 'token',
      account: {
        projectId: 'antigravity-project',
        tierId: UserTierId.STANDARD,
        tierName: 'Antigravity',
        paidTierId: 'g1-pro-tier',
        paidTierName: 'Google AI Pro',
      },
    });

    await expect(setupAntigravityUser(mockConfig)).resolves.toEqual({
      projectId: 'antigravity-project',
      userTier: 'g1-pro-tier',
      userTierName: 'Google AI Pro',
      paidTier: {
        id: 'g1-pro-tier',
        name: 'Google AI Pro',
        userDefinedCloudaicompanionProject: false,
      },
    });
  });

  it('defaults to the standard tier when the backend reports none', async () => {
    mockedResolveAntigravitySession.mockResolvedValue({
      token: 'token',
      account: { projectId: 'antigravity-project' },
    });

    await expect(setupAntigravityUser(mockConfig)).resolves.toEqual({
      projectId: 'antigravity-project',
      userTier: UserTierId.STANDARD,
      userTierName: undefined,
      paidTier: undefined,
    });
  });

  it('propagates sign-in failures', async () => {
    mockedResolveAntigravitySession.mockRejectedValue(
      new Error('Google OAuth did not return an access token.'),
    );

    await expect(setupAntigravityUser(mockConfig)).rejects.toThrow(
      'Google OAuth did not return an access token.',
    );
  });
});
