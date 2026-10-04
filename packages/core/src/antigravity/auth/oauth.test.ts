/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../../config/config.js';
import { AuthType } from '../../core/contentGenerator.js';
import { getOauthClient } from '../../code_assist/oauth2.js';
import {
  CLIENT_ID_ENV_VAR,
  CLIENT_SECRET_ENV_VAR,
  antigravityOAuthProfile,
  getAntigravityApiKey,
  getAntigravityOauthClient,
  loginAntigravity,
  resolveAntigravitySession,
} from './oauth.js';
import { fetchAntigravityAccount } from '../client/client.js';
import {
  clearCachedAntigravityAccount,
  readCachedAntigravityAccount,
  writeCachedAntigravityAccount,
} from './storage.js';

vi.mock('../../code_assist/oauth2.js');
vi.mock('../client/client.js');
vi.mock('./storage.js');

const mockedGetOauthClient = vi.mocked(getOauthClient);
const mockedFetchAntigravityAccount = vi.mocked(fetchAntigravityAccount);
const mockedReadCachedAntigravityAccount = vi.mocked(
  readCachedAntigravityAccount,
);
const mockedWriteCachedAntigravityAccount = vi.mocked(
  writeCachedAntigravityAccount,
);

const mockConfig = {} as Config;
const authClient = { getAccessToken: vi.fn() };

describe('antigravity/auth/oauth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedGetOauthClient.mockResolvedValue(authClient as never);
    mockedReadCachedAntigravityAccount.mockResolvedValue(undefined);
    authClient.getAccessToken.mockResolvedValue({ token: 'access-token' });
  });

  afterEach(async () => {
    await clearCachedAntigravityAccount();
  });

  it('uses the Antigravity OAuth identity for Sign in with Google', async () => {
    await getAntigravityOauthClient(mockConfig);

    expect(mockedGetOauthClient).toHaveBeenCalledWith(
      AuthType.LOGIN_WITH_GOOGLE,
      mockConfig,
      antigravityOAuthProfile(),
    );
    expect(antigravityOAuthProfile().clientId).toContain(
      'apps.googleusercontent.com',
    );
    expect(antigravityOAuthProfile().scopes).toEqual(
      expect.arrayContaining([
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ]),
    );
  });

  it('decodes the bundled installed-application credentials', () => {
    const profile = antigravityOAuthProfile();

    expect(profile.clientId).toBe(
      '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    );
    expect(profile.clientSecret).toBe('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');
  });

  it('honours an OAuth client override', () => {
    vi.stubEnv(CLIENT_ID_ENV_VAR, 'custom-id.apps.googleusercontent.com');
    vi.stubEnv(CLIENT_SECRET_ENV_VAR, 'custom-secret');

    const profile = antigravityOAuthProfile();

    expect(profile.clientId).toBe('custom-id.apps.googleusercontent.com');
    expect(profile.clientSecret).toBe('custom-secret');
  });

  it('returns the token and discovered project', async () => {
    mockedFetchAntigravityAccount.mockResolvedValue({
      projectId: 'antigravity-project',
      tierId: 'free-tier',
    });

    await expect(loginAntigravity(mockConfig)).resolves.toEqual({
      token: 'access-token',
      projectId: 'antigravity-project',
    });
    expect(mockedFetchAntigravityAccount).toHaveBeenCalledWith('access-token');
    expect(mockedWriteCachedAntigravityAccount).toHaveBeenCalledWith({
      projectId: 'antigravity-project',
    });
  });

  it('falls back to the cached project when discovery fails', async () => {
    mockedFetchAntigravityAccount.mockResolvedValue(undefined);
    mockedReadCachedAntigravityAccount.mockResolvedValue({
      projectId: 'cached-project',
    });

    await expect(resolveAntigravitySession(mockConfig)).resolves.toEqual({
      token: 'access-token',
      account: { projectId: 'cached-project' },
    });
    expect(mockedWriteCachedAntigravityAccount).toHaveBeenCalledWith({
      projectId: 'cached-project',
    });
  });

  it('throws when no project can be resolved', async () => {
    mockedFetchAntigravityAccount.mockResolvedValue(undefined);

    await expect(loginAntigravity(mockConfig)).rejects.toThrow(
      'no Antigravity project was returned',
    );
    expect(mockedWriteCachedAntigravityAccount).not.toHaveBeenCalled();
  });

  it('throws when OAuth returns no access token', async () => {
    authClient.getAccessToken.mockResolvedValue({ token: null });

    await expect(loginAntigravity(mockConfig)).rejects.toThrow(
      'did not return an access token',
    );
    expect(mockedFetchAntigravityAccount).not.toHaveBeenCalled();
  });

  it('serializes credentials as the API key payload', async () => {
    mockedFetchAntigravityAccount.mockResolvedValue({
      projectId: 'antigravity-project',
    });

    await expect(getAntigravityApiKey(mockConfig)).resolves.toBe(
      JSON.stringify({
        token: 'access-token',
        projectId: 'antigravity-project',
      }),
    );
  });
});
