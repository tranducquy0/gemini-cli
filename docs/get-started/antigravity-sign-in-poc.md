# Antigravity sign-in (proof of concept)

Gemini Code Assist for individuals stopped serving requests on June 18, 2026,
which means the classic **Sign in with Google** path no longer has a backend to
talk to. This page documents the stopgap wired into this fork: routing that
option through [Antigravity](https://antigravity.google/) instead.

<!-- prettier-ignore -->
> [!WARNING]
> This is a proof of concept, not a supported authentication method. Don't use
> it with your primary Google account. See
> [Before you try this](#before-you-try-this) for the specific reasons, and use
> a [supported method](./authentication.mdx#auth-methods)
> for anything you depend on.

## What changed

**Sign in with Google** now completes the OAuth flow with Antigravity's
first-party client and sends requests to Antigravity's Cloud Code Assist
backend. The rest of Gemini CLI is unchanged: same prompts, same credential
storage, same `~/.gemini` layout.

Concretely, the fork:

- Requests Antigravity's scope grant instead of Gemini Code Assist's, using
  Antigravity's registered OAuth client and callback route.
- Resolves your Antigravity project through `loadCodeAssist` and caches the
  project ID in `~/.gemini/oauth_creds.json` next to your tokens.
- Talks to `daily-cloudcode-pa.googleapis.com`, the cluster that serves consumer
  Antigravity accounts, using Antigravity's client fingerprint headers.
- Maps the Antigravity plan onto the existing tier data, so quota and billing
  displays keep working.

Access tokens still come from Gemini CLI's OAuth client, which means they
refresh on their own and revoke with `/auth`.

## Before you try this

The proof of concept borrows an authentication path that Google hasn't opened up
to third-party clients. That comes with real consequences:

- **It's unsupported.** Google can change Antigravity's OAuth client, scopes,
  headers, or endpoints without notice, and this breaks the next morning.
- **Entitlement is the gate.** Requests are only served for accounts that
  Antigravity actually recognizes. Otherwise the backend answers `403` with
  `SUBSCRIPTION_REQUIRED` ("You do not have a valid license of this product",
  error `#3501`), no matter how correct the request looks.
- **It spends Antigravity quota.** Requests count against the Antigravity plan
  attached to the account you signed in with.
- **Model coverage is partial.** Antigravity serves its own model catalog.
  Gemini CLI can request a model that your account isn't entitled to, and the
  failure surfaces mid-conversation.

None of that is a great trade for the account you rely on. Use an
[API key](./authentication.mdx#gemini-api) or
[Vertex AI](./authentication.mdx#vertex-ai) instead.

## Try it

To attempt a sign-in with Antigravity:

1. Start the CLI:

   ```bash
   gemini
   ```

2. Select **Sign in with Google** and complete the browser flow.

3. Send a prompt. Watch for `403 SUBSCRIPTION_REQUIRED`, which means the account
   isn't recognized as an Antigravity account (see
   [Troubleshooting](#troubleshooting)).

### Without a browser

Set `NO_BROWSER=true` to sign in from a machine that can't open a browser.
Because Antigravity only registers a loopback callback, the CLI prints the
authorization URL and asks you to paste the URL your browser ends up on:

```bash
NO_BROWSER=true gemini
```

The pasted URL has to come from the sign-in you just started, since the CLI
checks its `state` value.

### Configuration

Every setting is optional. The defaults match Antigravity's own clients.

| Variable                    | Purpose                                                  |
| :-------------------------- | :------------------------------------------------------- |
| `ANTIGRAVITY_BASE_URL`      | Backend origin, for example a local gateway              |
| `ANTIGRAVITY_CLIENT_ID`     | OAuth client ID to use instead of Antigravity's          |
| `ANTIGRAVITY_CLIENT_SECRET` | OAuth client secret to pair with a custom client ID      |
| `ANTIGRAVITY_REDIRECT_URI`  | Callback route, when your OAuth client registers another |

## Troubleshooting

Turn on a debug log to see what the backend reported:

```bash
GEMINI_DEBUG_LOG_FILE=/tmp/gemini-debug.log gemini
```

Two failures come up most often.

### A `400` appears in the browser before the consent page

Google rejected the authorization request. It usually means the redirect URI,
the PKCE challenge, or the requested scopes don't match what the OAuth client
registered. Check that you aren't overriding `ANTIGRAVITY_REDIRECT_URI` or
`ANTIGRAVITY_CLIENT_ID` with values from a different client.

### A `403` mentions `SUBSCRIPTION_REQUIRED`

The sign-in worked, but the account isn't entitled to the request. Look for the
`Antigravity account ready` line in the debug log to see the resolved project,
plan, and endpoint:

```text
Antigravity account ready (project=…, tier=…, tierName=…, endpoint=…)
```

An unfamiliar tier or an empty plan name usually means the account has never
used Antigravity. Signing in with the Antigravity CLI (`agy`) or the Antigravity
IDE once can establish the entitlement, after which requests are served. A
Google Workspace or organization account without a Gemini Code Assist Standard
or Enterprise license has no such path, and no client-side change can grant it.

## Next steps

- Review the [authentication overview](./authentication.mdx#auth-methods) for
  supported options.
- Report findings in the
  [gemini-cli issue tracker](https://github.com/google-gemini/gemini-cli/issues),
  including the debug log with tokens redacted.
