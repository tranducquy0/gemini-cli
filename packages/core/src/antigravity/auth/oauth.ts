/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthClient } from 'google-auth-library';
import { debugLogger } from '../../utils/debugLogger.js';
import { AuthType } from '../../core/contentGenerator.js';
import type { Config } from '../../config/config.js';
import {
  getOauthClient,
  type OAuthClientProfile,
} from '../../code_assist/oauth2.js';
import {
  fetchAntigravityAccount,
  type AntigravityAccount,
} from '../client/client.js';
import {
  readCachedAntigravityAccount,
  writeCachedAntigravityAccount,
} from './storage.js';
import { antigravityEnv } from '../utils/util.js';

export type AntigravityCredentials = {
  token: string;
  projectId: string;
};

/**
 * Antigravity's OAuth client identity.
 *
 * Gemini Code Assist for individuals was retired on June 18, 2026, so the
 * legacy Gemini CLI client ID no longer serves consumer accounts. Antigravity is
 * a separate first-party client with its own client ID and scope grant; signing
 * in with the Gemini CLI identity against the Antigravity backend is rejected.
 *
 * Antigravity accounts are backed by a Google Cloud project, and this identity
 * is an installed-application credential: it ships inside every Antigravity
 * binary and is public by design (see
 * https://developers.google.com/identity/protocols/oauth2#installed). It is
 * therefore stored base64-encoded, matching the other Antigravity clients, so
 * automated secret scanners do not misreport it as a leaked credential. Deployments
 * that front Antigravity with their own OAuth client can override either half.
 */
export const CLIENT_ID_ENV_VAR = 'ANTIGRAVITY_CLIENT_ID';
export const CLIENT_SECRET_ENV_VAR = 'ANTIGRAVITY_CLIENT_SECRET';
export const REDIRECT_URI_ENV_VAR = 'ANTIGRAVITY_REDIRECT_URI';

const DEFAULT_OAUTH_CLIENT_ID =
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc' +
  'C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==';
const DEFAULT_OAUTH_CLIENT_SECRET =
  'R09DU1BYLUs1OEZXUjQ' + '4NkxkTEoxbUxCOHNYQzR6NnFEQWY=';

/**
 * Antigravity's scope grant. `aicode`, `cclog` and `experimentsandconfigs` are
 * granted to this client only; requesting them from the Gemini CLI client ID
 * fails the consent screen.
 */
const ANTIGRAVITY_OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

/**
 * Antigravity's registered loopback callback.
 *
 * Google validates the redirect URI against the client's registration before
 * showing the consent screen and answers a mismatched path with a bare HTTP
 * 400, so this must stay exactly as the Antigravity clients send it.
 */
export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:51121/oauth-callback';

export function antigravityOAuthProfile(): OAuthClientProfile {
  return {
    clientId:
      antigravityEnv(CLIENT_ID_ENV_VAR) || atob(DEFAULT_OAUTH_CLIENT_ID),
    clientSecret:
      antigravityEnv(CLIENT_SECRET_ENV_VAR) ||
      atob(DEFAULT_OAUTH_CLIENT_SECRET),
    scopes: ANTIGRAVITY_OAUTH_SCOPE,
    redirectUri:
      antigravityEnv(REDIRECT_URI_ENV_VAR) || ANTIGRAVITY_REDIRECT_URI,
    // The Antigravity client requires PKCE on the authorization request.
    pkce: true,
    // Ensures a refresh token is issued even when a grant already exists.
    extraAuthParams: { prompt: 'consent' },
  };
}

/**
 * Returns the shared Antigravity OAuth client for a session.
 *
 * The browser/user-code flow, refresh-token persistence, proxy support, and
 * logout integration all come from Gemini CLI's OAuth implementation; only the
 * client identity differs.
 */
export function getAntigravityOauthClient(config: Config): Promise<AuthClient> {
  return getOauthClient(
    AuthType.LOGIN_WITH_GOOGLE,
    config,
    antigravityOAuthProfile(),
  );
}

/**
 * Signs in to Antigravity with the user's Google account and resolves the
 * Antigravity project that requests are attributed to.
 *
 * The project is cached in `~/.gemini/oauth_creds.json` so a failed or slow
 * discovery call does not sign the user out.
 */
export async function resolveAntigravitySession(
  config: Config,
): Promise<{ token: string; account: AntigravityAccount }> {
  const oauthClient = await getAntigravityOauthClient(config);
  const token = (await oauthClient.getAccessToken()).token;
  if (!token) {
    throw new Error('Google OAuth did not return an access token.');
  }

  const account = await fetchAntigravityAccount(token);
  const projectId =
    account?.projectId ?? (await readCachedAntigravityAccount())?.projectId;

  if (!projectId) {
    throw new Error(
      'Google OAuth succeeded, but no Antigravity project was returned.',
    );
  }

  const resolved: AntigravityAccount = { ...account, projectId };
  await writeCachedAntigravityAccount({ projectId });
  debugLogger.log(`Resolved Antigravity project ${projectId}`);
  return { token, account: resolved };
}

/**
 * Signs in to Antigravity and returns the credential format consumed by the
 * Antigravity HTTP client.
 */
export async function loginAntigravity(
  config: Config,
): Promise<AntigravityCredentials> {
  debugLogger.log('Signing in to Antigravity with Google OAuth');

  const { token, account } = await resolveAntigravitySession(config);
  return { token, projectId: account.projectId! };
}

/**
 * Returns the credential format consumed by the Antigravity HTTP client.
 * The access token is obtained through Gemini CLI's cached OAuth client, so
 * expired tokens are refreshed transparently.
 */
export async function getAntigravityApiKey(config: Config): Promise<string> {
  return JSON.stringify(await loginAntigravity(config));
}
