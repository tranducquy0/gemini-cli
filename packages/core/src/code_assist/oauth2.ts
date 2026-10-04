/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  OAuth2Client,
  Compute,
  CodeChallengeMethod,
  GoogleAuth,
  type Credentials,
  type AuthClient,
  type JWTInput,
} from 'google-auth-library';
import * as http from 'node:http';
import url from 'node:url';
import crypto from 'node:crypto';
import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import open from 'open';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Config } from '../config/config.js';
import {
  getErrorMessage,
  FatalAuthenticationError,
  FatalCancellationError,
} from '../utils/errors.js';
import { UserAccountManager } from '../utils/userAccountManager.js';
import { AuthType } from '../core/contentGenerator.js';
import readline from 'node:readline';
import { Storage } from '../config/storage.js';
import { OAuthCredentialStorage } from './oauth-credential-storage.js';
import { FORCE_ENCRYPTED_FILE_ENV_VAR } from '../mcp/token-storage/index.js';
import { debugLogger } from '../utils/debugLogger.js';
import {
  writeToStdout,
  createWorkingStdio,
  writeToStderr,
} from '../utils/stdio.js';
import {
  enableLineWrapping,
  disableMouseEvents,
  disableKittyKeyboardProtocol,
  enterAlternateScreen,
  exitAlternateScreen,
} from '../utils/terminal.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
import { getConsentForOauth } from '../utils/authConsent.js';

export const authEvents = new EventEmitter();

/**
 * Identifies the Google OAuth client (and its scopes) used for a login flow.
 *
 * Gemini CLI and Antigravity are separate first-party clients: they use
 * different OAuth client IDs and, therefore, different scope grants and flow
 * parameters. Every token operation must be performed with the profile that
 * issued the cached refresh token, otherwise Google rejects the refresh.
 */
export interface OAuthClientProfile {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /**
   * Fixed loopback redirect URI. Google's authorization endpoint validates the
   * redirect URI against the client's registration (the port may vary for
   * loopback clients, the path may not), so a client that ships its own callback
   * route must declare it here instead of using the generated one.
   */
  redirectUri?: string;
  /** Sends PKCE (S256) on the browser flow. Required by some clients. */
  pkce?: boolean;
  /** Extra parameters appended to the authorization request. */
  extraAuthParams?: Record<string, string>;
  /**
   * Redirect URI for the no-browser (user code) flow. Defaults to Gemini CLI's
   * registered code-assist callback; clients without one cannot use it.
   */
  userCodeRedirectUri?: string;
}

async function triggerPostAuthCallbacks(
  tokens: Credentials,
  profile: OAuthClientProfile,
) {
  // Construct a JWTInput object to pass to callbacks, as this is the
  // type expected by the downstream Google Cloud client libraries.
  const jwtInput: JWTInput = {
    client_id: profile.clientId,
    client_secret: profile.clientSecret,
    refresh_token: tokens.refresh_token ?? undefined, // Ensure null is not passed
    type: 'authorized_user',
    client_email: userAccountManager.getCachedGoogleAccount() ?? undefined,
    quota_project_id:
      process.env['GOOGLE_CLOUD_QUOTA_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT_ID'],
  };

  // Execute all registered post-authentication callbacks.
  authEvents.emit('post_auth', jwtInput);
}

const userAccountManager = new UserAccountManager();

//  OAuth Client ID used to initiate OAuth2Client class.
const OAUTH_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';

// OAuth Secret value used to initiate OAuth2Client class.
// Note: It's ok to save this in git because this is an installed application
// as described here: https://developers.google.com/identity/protocols/oauth2#installed
// "The process results in a client ID and, in some cases, a client secret,
// which you embed in the source code of your application. (In this context,
// the client secret is obviously not treated as a secret.)"
const OAUTH_CLIENT_SECRET = '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';

// OAuth Scopes for Cloud Code authorization.
const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  // Required for Antigravity backend experiments/config
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

/**
 * The legacy Gemini CLI / Gemini Code Assist OAuth client.
 *
 * Kept for ADC and for Code Assist Standard/Enterprise workspaces, which are
 * the only Gemini Code Assist deployments still serving requests.
 */
export const GEMINI_OAUTH_PROFILE: OAuthClientProfile = {
  clientId: OAUTH_CLIENT_ID,
  clientSecret: OAUTH_CLIENT_SECRET,
  scopes: OAUTH_SCOPE,
};

const HTTP_REDIRECT = 301;
const CODE_ASSIST_USER_CODE_REDIRECT_URI =
  'https://codeassist.google.com/authcode';
const SIGN_IN_SUCCESS_URL =
  'https://developers.google.com/gemini-code-assist/auth_success_gemini';
const SIGN_IN_FAILURE_URL =
  'https://developers.google.com/gemini-code-assist/auth_failure_gemini';

/**
 * An Authentication URL for updating the credentials of a Oauth2Client
 * as well as a promise that will resolve when the credentials have
 * been refreshed (or which throws error when refreshing credentials failed).
 */
export interface OauthWebLogin {
  authUrl: string;
  loginCompletePromise: Promise<void>;
}

const oauthClientPromises = new Map<string, Promise<AuthClient>>();

function oauthClientCacheKey(
  authType: AuthType,
  profile: OAuthClientProfile,
): string {
  return `${authType}:${profile.clientId}`;
}

function getUseEncryptedStorageFlag() {
  return process.env[FORCE_ENCRYPTED_FILE_ENV_VAR] === 'true';
}

/**
 * Determines whether the given credentials object represents ADC credentials.
 */
function isAdcCredentials(
  credentials: unknown,
): credentials is JWTInput & { type: string } {
  if (credentials && typeof credentials === 'object' && 'type' in credentials) {
    const type = credentials.type;
    return typeof type === 'string' && type !== 'authorized_user';
  }
  return false;
}

async function initOauthClient(
  authType: AuthType,
  config: Config,
  profile: OAuthClientProfile,
): Promise<AuthClient> {
  function createBaseOAuth2Client(): OAuth2Client {
    const client = new OAuth2Client({
      clientId: profile.clientId,
      clientSecret: profile.clientSecret,
      transporterOptions: {
        proxy: config.getProxy(),
      },
    });
    const useEncryptedStorage = getUseEncryptedStorageFlag();

    client.on('tokens', async (tokens: Credentials) => {
      if (useEncryptedStorage) {
        await OAuthCredentialStorage.saveCredentials(tokens);
      } else {
        await cacheCredentials(tokens);
      }

      await triggerPostAuthCallbacks(tokens, profile);
    });

    return client;
  }

  // 1. Try GOOGLE_CLOUD_ACCESS_TOKEN override first if configured
  if (
    process.env['GOOGLE_GENAI_USE_GCA'] &&
    process.env['GOOGLE_CLOUD_ACCESS_TOKEN']
  ) {
    const client = createBaseOAuth2Client();
    client.setCredentials({
      access_token: process.env['GOOGLE_CLOUD_ACCESS_TOKEN'],
    });
    await fetchAndCacheUserInfo(client);
    return client;
  }

  const credentialsList = await fetchCachedCredentialsList();

  // 2. Iterate sequentially over the credentials list in their natural priority order
  for (const credentials of credentialsList) {
    if (isAdcCredentials(credentials)) {
      try {
        const auth = new GoogleAuth({
          scopes: profile.scopes,
        });
        const adcClient = auth.fromJSON({
          ...credentials,
          refresh_token: credentials.refresh_token ?? undefined,
        });
        const response = await adcClient.getAccessToken();
        const token = response.token ?? null;
        if (token) {
          debugLogger.debug('Created ' + credentials.type + ' auth client.');
          return adcClient;
        }
      } catch (error) {
        debugLogger.debug(
          'ADC credentials verification failed:',
          getErrorMessage(error),
        );
      }
    } else if (credentials) {
      const client = createBaseOAuth2Client();
      client.setCredentials(credentials as Credentials);
      try {
        // This will verify locally that the credentials look good.
        const { token } = await client.getAccessToken();
        if (token) {
          // This will check with the server to see if it hasn't been revoked.
          await client.getTokenInfo(token);

          if (!userAccountManager.getCachedGoogleAccount()) {
            try {
              await fetchAndCacheUserInfo(client);
            } catch (error) {
              // Non-fatal, continue with existing auth.
              debugLogger.warn(
                'Failed to fetch user info:',
                getErrorMessage(error),
              );
            }
          }
          debugLogger.log('Loaded cached credentials.');
          await triggerPostAuthCallbacks(
            client.credentials || (credentials as Credentials),
            profile,
          );

          return client;
        }
      } catch (error) {
        debugLogger.debug(
          'Cached credentials are not valid:',
          getErrorMessage(error),
        );
      }
    }
  }

  const client = createBaseOAuth2Client();

  // In Google Compute Engine based environments (including Cloud Shell), we can
  // use Application Default Credentials (ADC) provided via its metadata server
  // to authenticate non-interactively using the identity of the logged-in user.
  if (authType === AuthType.COMPUTE_ADC) {
    try {
      debugLogger.log(
        'Attempting to authenticate via metadata server application default credentials.',
      );

      const computeClient = new Compute({
        // We can leave this empty, since the metadata server will provide
        // the service account email.
      });
      await computeClient.getAccessToken();
      debugLogger.log('Authentication successful.');

      // Do not cache creds in this case; note that Compute client will handle its own refresh
      return computeClient;
    } catch (e) {
      throw new Error(
        `Could not authenticate using metadata server application default credentials. Please select a different authentication method or ensure you are in a properly configured environment. Error: ${getErrorMessage(
          e,
        )}`,
      );
    }
  }

  if (config.isBrowserLaunchSuppressed()) {
    if (!config.isInteractive()) {
      throw new FatalAuthenticationError(
        'Manual authorization is required but the current session is non-interactive. ' +
          'Please run the Gemini CLI in an interactive terminal to log in, ' +
          'provide a GEMINI_API_KEY, or ensure Application Default Credentials are configured.',
      );
    }
    let success = false;
    const maxRetries = 2;
    // Enter alternate buffer
    enterAlternateScreen();
    // Clear screen and move cursor to top-left.
    writeToStdout('\u001B[2J\u001B[H');
    disableMouseEvents();
    disableKittyKeyboardProtocol();
    enableLineWrapping();

    try {
      for (let i = 0; !success && i < maxRetries; i++) {
        success = await authWithUserCode(client, profile);
        if (!success) {
          writeToStderr(
            '\nFailed to authenticate with user code.' +
              (i === maxRetries - 1 ? '' : ' Retrying...\n'),
          );
        }
      }
    } finally {
      exitAlternateScreen();
      // If this was triggered from an active Gemini CLI TUI this event ensures
      // the TUI will re-initialize the terminal state just like it will when
      // another editor like VIM may have modified the buffer of settings.
      coreEvents.emit(CoreEvent.ExternalEditorClosed);
    }

    if (!success) {
      writeToStderr('Failed to authenticate with user code.\n');
      throw new FatalAuthenticationError(
        'Failed to authenticate with user code.',
      );
    }

    // Retrieve and cache Google Account ID after successful user code auth
    try {
      await fetchAndCacheUserInfo(client);
    } catch (error) {
      debugLogger.warn(
        'Failed to retrieve Google Account ID during authentication:',
        getErrorMessage(error),
      );
    }

    await triggerPostAuthCallbacks(client.credentials, profile);
  } else {
    // In ACP mode, we skip the interactive consent and directly open the browser
    if (!config.getAcpMode()) {
      const userConsent = await getConsentForOauth('');
      if (!userConsent) {
        throw new FatalCancellationError('Authentication cancelled by user.');
      }
    }

    const webLogin = await authWithWeb(client, profile);

    coreEvents.emit(CoreEvent.UserFeedback, {
      severity: 'info',
      message:
        `\n\nAttempting to open authentication page in your browser.\n` +
        `Otherwise navigate to:\n\n${webLogin.authUrl}\n\n\n`,
    });
    try {
      // Attempt to open the authentication URL in the default browser.
      // We do not use the `wait` option here because the main script's execution
      // is already paused by `loginCompletePromise`, which awaits the server callback.
      const childProcess = await open(webLogin.authUrl);

      // IMPORTANT: Attach an error handler to the returned child process.
      // Without this, if `open` fails to spawn a process (e.g., `xdg-open` is not found
      // in a minimal Docker container), it will emit an unhandled 'error' event,
      // causing the entire Node.js process to crash.
      childProcess.on('error', (error) => {
        coreEvents.emit(CoreEvent.UserFeedback, {
          severity: 'error',
          message:
            `Failed to open browser with error: ${getErrorMessage(error)}\n` +
            `Please try running again with NO_BROWSER=true set.`,
        });
      });
    } catch (err) {
      coreEvents.emit(CoreEvent.UserFeedback, {
        severity: 'error',
        message:
          `Failed to open browser with error: ${getErrorMessage(err)}\n` +
          `Please try running again with NO_BROWSER=true set.`,
      });
      throw new FatalAuthenticationError(
        `Failed to open browser: ${getErrorMessage(err)}`,
      );
    }
    coreEvents.emit(CoreEvent.UserFeedback, {
      severity: 'info',
      message: 'Waiting for authentication...\n',
    });

    // Add timeout to prevent infinite waiting when browser tab gets stuck
    const authTimeout = 5 * 60 * 1000; // 5 minutes timeout
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new FatalAuthenticationError(
            'Authentication timed out after 5 minutes. The browser tab may have gotten stuck in a loading state. ' +
              'Please try again or use NO_BROWSER=true for manual authentication.',
          ),
        );
      }, authTimeout);
    });

    // Listen for SIGINT to stop waiting for auth so the terminal doesn't hang
    // if the user chooses not to auth.
    let sigIntHandler: (() => void) | undefined;
    let stdinHandler: ((data: Buffer) => void) | undefined;
    const cancellationPromise = new Promise<never>((_, reject) => {
      sigIntHandler = () =>
        reject(new FatalCancellationError('Authentication cancelled by user.'));
      process.on('SIGINT', sigIntHandler);

      // Note that SIGINT might not get raised on Ctrl+C in raw mode
      // so we also need to look for Ctrl+C directly in stdin.
      // Only match a lone 0x03 byte — some terminals (e.g. Ghostty) embed
      // 0x03 inside multi-byte escape sequences, causing false cancellations.
      stdinHandler = (data: Buffer) => {
        if (data.length === 1 && data[0] === 0x03) {
          reject(
            new FatalCancellationError('Authentication cancelled by user.'),
          );
        }
      };
      process.stdin.on('data', stdinHandler);
    });

    try {
      await Promise.race([
        webLogin.loginCompletePromise,
        timeoutPromise,
        cancellationPromise,
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (sigIntHandler) {
        process.removeListener('SIGINT', sigIntHandler);
      }
      if (stdinHandler) {
        process.stdin.removeListener('data', stdinHandler);
      }
    }

    coreEvents.emit(CoreEvent.UserFeedback, {
      severity: 'info',
      message: 'Authentication succeeded\n',
    });

    await triggerPostAuthCallbacks(client.credentials, profile);
  }

  return client;
}

export async function getOauthClient(
  authType: AuthType,
  config: Config,
  profile: OAuthClientProfile = GEMINI_OAUTH_PROFILE,
): Promise<AuthClient> {
  const key = oauthClientCacheKey(authType, profile);
  if (!oauthClientPromises.has(key)) {
    oauthClientPromises.set(key, initOauthClient(authType, config, profile));
  }
  return oauthClientPromises.get(key)!;
}

async function authWithUserCode(
  client: OAuth2Client,
  profile: OAuthClientProfile,
): Promise<boolean> {
  try {
    // Gemini CLI's OAuth app has a redirect that renders the code on a Google
    // page. Other clients (Antigravity) only have a loopback callback, so their
    // user-code flow advertises that unreachable loopback URI and asks for the
    // pasted callback URL instead.
    const pasteCallbackUrl =
      !profile.userCodeRedirectUri && !!profile.redirectUri;
    const redirectUri =
      profile.userCodeRedirectUri ??
      profile.redirectUri ??
      CODE_ASSIST_USER_CODE_REDIRECT_URI;
    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = await client.generateCodeVerifierAsync();
    const authUrl: string = client.generateAuthUrl({
      redirect_uri: redirectUri,
      access_type: 'offline',
      scope: profile.scopes,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeVerifier.codeChallenge,
      state,
      ...profile.extraAuthParams,
    });
    writeToStdout(
      'Please visit the following URL to authorize the application:\n\n' +
        authUrl +
        '\n\n' +
        (pasteCallbackUrl
          ? 'Your browser cannot reach this machine, so the authorization page ' +
            'will show an error. Paste the full URL from your browser address ' +
            'bar instead.\n\n'
          : ''),
    );

    let authTimeoutId: NodeJS.Timeout | undefined;
    const answer = await new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: createWorkingStdio().stdout,
        terminal: true,
      });

      const abortController = new AbortController();
      authTimeoutId = setTimeout(() => {
        abortController.abort(
          new FatalAuthenticationError(
            'Authorization timed out after 5 minutes.',
          ),
        );
      }, 300000); // 5 minute timeout
      authTimeoutId.unref();

      const onAbort = () => {
        rl.close();
        reject(abortController.signal.reason);
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });

      rl.question(
        pasteCallbackUrl
          ? `Paste the redirected URL (${redirectUri}): `
          : 'Enter the authorization code: ',
        (value) => {
          abortController.signal.removeEventListener('abort', onAbort);
          rl.close();
          resolve(value.trim());
        },
      );
    }).finally(() => {
      if (authTimeoutId) clearTimeout(authTimeoutId);
    });

    const pastedResult = pasteCallbackUrl
      ? extractPastedCallbackCode(answer, state)
      : undefined;
    const code = pastedResult ? pastedResult.code : answer;

    if (!code) {
      const message = pastedResult?.error ?? 'Authorization code is required.';
      writeToStderr(`${message}\n`);
      debugLogger.error(message);
      return false;
    }

    try {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: codeVerifier.codeVerifier,
        redirect_uri: redirectUri,
      });
      client.setCredentials(tokens);
    } catch (error) {
      writeToStderr(
        'Failed to authenticate with authorization code:' +
          getErrorMessage(error) +
          '\n',
      );

      debugLogger.error(
        'Failed to authenticate with authorization code:',
        getErrorMessage(error),
      );
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof FatalCancellationError) {
      throw err;
    }
    writeToStderr(
      'Failed to authenticate with user code:' + getErrorMessage(err) + '\n',
    );
    debugLogger.error(
      'Failed to authenticate with user code:',
      getErrorMessage(err),
    );
    return false;
  }
}

/**
 * Extracts the authorization code from a callback URL pasted by the user, e.g.
 * when NO_BROWSER is set and the browser cannot reach the loopback callback.
 *
 * Accepts a full URL or a bare query string and validates the state, mirroring
 * the checks the callback server performs.
 */
function extractPastedCallbackCode(
  pasted: string,
  expectedState: string,
): { code?: string; error?: string } {
  if (!pasted) {
    return { error: 'No redirect URL was provided.' };
  }

  const query = pasted.includes('?')
    ? pasted.slice(pasted.indexOf('?') + 1)
    : pasted;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return { error: 'Could not parse the pasted URL.' };
  }

  const error = params.get('error');
  if (error) {
    return {
      error: `Authorization failed: ${error.slice(0, 200)}`,
    };
  }
  const code = params.get('code');
  if (!code) {
    return {
      error: 'The pasted URL does not contain an authorization code.',
    };
  }
  if (params.get('state') !== expectedState) {
    return {
      error:
        'OAuth state mismatch. Please retry the sign-in and paste the new URL.',
    };
  }
  return { code };
}

async function authWithWeb(
  client: OAuth2Client,
  profile: OAuthClientProfile,
): Promise<OauthWebLogin> {
  // Clients that ship their own callback route must advertise that exact route:
  // Google validates the redirect URI against the client's registration before
  // showing the consent screen, and an unregistered path fails with a bare 400.
  const redirectUri = profile.redirectUri ?? (await getLoopbackRedirectUri());
  const { host, port } = await getCallbackBinding(redirectUri);
  const state = crypto.randomBytes(32).toString('hex');
  const codeVerifier = profile.pkce
    ? await client.generateCodeVerifierAsync()
    : undefined;

  const authUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    scope: profile.scopes,
    state,
    ...(codeVerifier && {
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeVerifier.codeChallenge,
    }),
    ...profile.extraAuthParams,
  });

  const loginCompletePromise = new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const callbackPath = new URL(redirectUri).pathname;
        if (req.url!.indexOf(callbackPath) === -1) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
          res.end();
          reject(
            new FatalAuthenticationError(
              'OAuth callback not received. Unexpected request: ' + req.url,
            ),
          );
          return;
        }
        // acquire the code from the querystring, and close the web server.
        const qs = new url.URL(req.url!, 'http://127.0.0.1:3000').searchParams;
        if (qs.get('error')) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
          res.end();

          const errorCode = qs.get('error');
          const errorDescription =
            qs.get('error_description') || 'No additional details provided';
          reject(
            new FatalAuthenticationError(
              `Google OAuth error: ${errorCode}. ${errorDescription}`,
            ),
          );
        } else if (qs.get('state') !== state) {
          res.end('State mismatch. Possible CSRF attack');

          reject(
            new FatalAuthenticationError(
              'OAuth state mismatch. Possible CSRF attack or browser session issue.',
            ),
          );
        } else if (qs.get('code')) {
          try {
            const { tokens } = await client.getToken({
              code: qs.get('code')!,
              redirect_uri: redirectUri,
              ...(codeVerifier && { codeVerifier: codeVerifier.codeVerifier }),
            });
            client.setCredentials(tokens);

            // Retrieve and cache Google Account ID during authentication
            try {
              await fetchAndCacheUserInfo(client);
            } catch (error) {
              debugLogger.warn(
                'Failed to retrieve Google Account ID during authentication:',
                getErrorMessage(error),
              );
              // Don't fail the auth flow if Google Account ID retrieval fails
            }

            res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_SUCCESS_URL });
            res.end();
            resolve();
          } catch (error) {
            res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
            res.end();
            reject(
              new FatalAuthenticationError(
                `Failed to exchange authorization code for tokens: ${getErrorMessage(error)}`,
              ),
            );
          }
        } else {
          reject(
            new FatalAuthenticationError(
              'No authorization code received from Google OAuth. Please try authenticating again.',
            ),
          );
        }
      } catch (e) {
        // Provide more specific error message for unexpected errors during OAuth flow
        if (e instanceof FatalAuthenticationError) {
          reject(e);
        } else {
          reject(
            new FatalAuthenticationError(
              `Unexpected error during OAuth authentication: ${getErrorMessage(e)}`,
            ),
          );
        }
      } finally {
        server.close();
      }
    });

    server.listen(port, host, () => {
      // Server started successfully
    });

    server.on('error', (err) => {
      reject(
        new FatalAuthenticationError(
          `OAuth callback server error: ${getErrorMessage(err)}`,
        ),
      );
    });
  });

  return {
    authUrl,
    loginCompletePromise,
  };
}

/**
 * Builds the default loopback redirect URI for the browser flow.
 *
 * The `redirect_uri` sent to Google's authorization server MUST use a loopback
 * IP literal (i.e., 'localhost' or '127.0.0.1'). This is a strict security
 * policy for credentials of type 'Desktop app' or 'Web application' (when using
 * loopback flow) to mitigate authorization code interception attacks.
 */
async function getLoopbackRedirectUri(): Promise<string> {
  const port = await getAvailablePort();
  return `http://127.0.0.1:${port}/oauth2callback`;
}

/**
 * Resolves the host/port the callback server binds to. The port always comes
 * from the redirect URI so the listener matches what was sent to Google; the
 * host honours `OAUTH_CALLBACK_HOST` (e.g., '0.0.0.0' in Docker).
 */
async function getCallbackBinding(
  redirectUri: string,
): Promise<{ host: string; port: number }> {
  const url = new URL(redirectUri);
  const host =
    process.env['OAUTH_CALLBACK_HOST'] || url.hostname || '127.0.0.1';
  const port = url.port ? Number(url.port) : await getAvailablePort();
  return { host, port };
}

export function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = 0;
    try {
      const portStr = process.env['OAUTH_CALLBACK_PORT'];
      if (portStr) {
        port = parseInt(portStr, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
          return reject(
            new Error(`Invalid value for OAUTH_CALLBACK_PORT: "${portStr}"`),
          );
        }
        return resolve(port);
      }
      const server = net.createServer();
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          port = address.port;
        }
      });
      server.on('listening', () => {
        server.close();
        server.unref();
      });
      server.on('error', (e) => reject(e));
      server.on('close', () => resolve(port));
    } catch (e) {
      reject(e);
    }
  });
}

export async function readOAuthCredsWithRetry(
  filePath: string,
  maxRetries = 3,
): Promise<string> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        err.code === 'ENOENT'
      ) {
        throw err;
      }
      attempt++;
      if (attempt >= maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
  return '';
}

async function fetchCachedCredentialsList(): Promise<
  Array<Credentials | JWTInput>
> {
  const credentialsList: Array<Credentials | JWTInput> = [];
  const useEncryptedStorage = getUseEncryptedStorageFlag();
  if (useEncryptedStorage) {
    try {
      const creds = await OAuthCredentialStorage.loadCredentials();
      if (creds) {
        credentialsList.push(creds);
      }
    } catch (error) {
      debugLogger.debug(
        'Failed to load credentials from encrypted storage:',
        error,
      );
    }
  }

  const pathsToTry = [
    ...(!useEncryptedStorage ? [Storage.getOAuthCredsPath()] : []),
    process.env['GOOGLE_APPLICATION_CREDENTIALS'],
  ].filter((p): p is string => !!p);

  for (const keyFile of pathsToTry) {
    try {
      const keyFileString = await readOAuthCredsWithRetry(keyFile);
      const parsed: unknown = JSON.parse(keyFileString);
      const isOAuthCreds = (val: unknown): val is Credentials | JWTInput =>
        typeof val === 'object' && val !== null;
      if (isOAuthCreds(parsed)) {
        credentialsList.push(parsed);
      } else {
        throw new Error('Invalid credentials format');
      }
    } catch (error) {
      // Log specific error for debugging, but continue trying other paths
      debugLogger.debug(
        `Failed to load credentials from ${keyFile}:`,
        getErrorMessage(error),
      );
    }
  }

  return credentialsList;
}

export function clearOauthClientCache() {
  oauthClientPromises.clear();
}

export async function clearCachedCredentialFile() {
  try {
    const useEncryptedStorage = getUseEncryptedStorageFlag();
    if (useEncryptedStorage) {
      await OAuthCredentialStorage.clearCredentials();
    } else {
      await fs.rm(Storage.getOAuthCredsPath(), { force: true });
    }
    // Clear the Google Account ID cache when credentials are cleared
    await userAccountManager.clearCachedGoogleAccount();
    // Clear the in-memory OAuth client cache to force re-authentication
    clearOauthClientCache();
  } catch (e) {
    debugLogger.warn('Failed to clear cached credentials:', e);
  }
}

async function fetchAndCacheUserInfo(client: OAuth2Client): Promise<void> {
  try {
    const { token } = await client.getAccessToken();
    if (!token) {
      return;
    }

    const response = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      debugLogger.log(
        'Failed to fetch user info:',
        response.status,
        response.statusText,
      );
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const userInfo = await response.json();
    await userAccountManager.cacheGoogleAccount(userInfo.email);
  } catch (error) {
    debugLogger.log('Error retrieving user info:', error);
  }
}

// Helper to ensure test isolation
export function resetOauthClientForTesting() {
  oauthClientPromises.clear();
}

let tempCounter = 0;

async function cacheCredentials(credentials: Credentials) {
  const filePath = Storage.getOAuthCredsPath();
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });

  let existing: Credentials = {};
  try {
    const existingContent = await readOAuthCredsWithRetry(filePath);
    const parsed: unknown = JSON.parse(existingContent);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Credentials;
    }
  } catch (error: unknown) {
    const isNoEnt =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT';
    if (!isNoEnt && !(error instanceof SyntaxError)) {
      throw error;
    }
  }

  const cleanCredentials = Object.fromEntries(
    Object.entries(credentials).filter(
      ([_, v]) => v !== null && v !== undefined,
    ),
  );

  const finalCredentials = {
    ...existing,
    ...cleanCredentials,
  };

  const credString = JSON.stringify(finalCredentials, null, 2);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, credString, { mode: 0o600 });
    try {
      await fs.chmod(tempPath, 0o600);
    } catch {
      /* empty */
    }
    await fs.rename(tempPath, filePath);
  } catch {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      /* empty */
    }
    // Fallback to direct write if rename fails
    await fs.writeFile(filePath, credString, { mode: 0o600 });
  }

  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    /* empty */
  }
}
