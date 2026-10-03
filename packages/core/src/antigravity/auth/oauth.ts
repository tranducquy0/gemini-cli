import { debugLogger } from "../../utils/debugLogger.js";
import { AuthType } from "../../core/contentGenerator.js";
import type { Config } from "../../config/config.js";
import { getOauthClient } from "../../code_assist/oauth2.js";
import { loadCodeAssist } from "../client/client.js";

export type AntigravityCredentials = {
  token: string;
  projectId: string;
};

/**
 * Sign in to Antigravity using the CLI's first-party Google OAuth flow.
 *
 * Reusing getOauthClient is intentional: it provides the browser/user-code
 * flow, refresh-token persistence, proxy support, and logout integration used
 * by the rest of Gemini CLI.
 */
export async function loginAntigravity(
  config: Config,
): Promise<AntigravityCredentials> {
  debugLogger.log("Signing in to Antigravity with Google OAuth");

  const oauthClient = await getOauthClient(AuthType.LOGIN_WITH_GOOGLE, config);
  const accessToken = (await oauthClient.getAccessToken()).token;
  if (!accessToken) {
    throw new Error("Google OAuth did not return an access token.");
  }

  const projectId = await loadCodeAssist(accessToken);
  if (!projectId) {
    throw new Error(
      "Google OAuth succeeded, but no Antigravity project was returned.",
    );
  }

  return { token: accessToken, projectId };
}

/**
 * Returns the credential format consumed by the Antigravity HTTP client.
 * The access token is obtained through Gemini CLI's cached OAuth client, so
 * expired tokens are refreshed transparently.
 */
export async function getAntigravityApiKey(config: Config): Promise<string> {
  return JSON.stringify(await loginAntigravity(config));
}
