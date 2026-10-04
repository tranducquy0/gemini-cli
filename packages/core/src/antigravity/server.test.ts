/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthClient } from 'google-auth-library';
import type { Config } from '../config/config.js';
import { LlmRole } from '../telemetry/types.js';
import { UserTierId } from '../code_assist/types.js';
import { CodeAssistServer } from '../code_assist/server.js';
import {
  antigravityBackend,
  createAntigravityEnvelope,
  createAntigravityServer,
} from './server.js';
import { DEFAULT_ENDPOINT } from './client/client.js';

const requestMock = vi.fn();

const authClient = {
  request: requestMock,
} as unknown as AuthClient;

const streamResponse = {
  data: (async function* () {
    yield Buffer.from(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n',
    );
  })(),
};

const userData = {
  projectId: 'antigravity-project',
  userTier: UserTierId.FREE,
  userTierName: 'Antigravity',
};

async function drain(
  server: CodeAssistServer,
): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = [];
  for await (const chunk of await server.generateContentStream(
    { model: 'gemini-3-flash', contents: 'hello' },
    'prompt-1',
    LlmRole.MAIN,
  )) {
    chunks.push(chunk as unknown as Record<string, unknown>);
  }
  return chunks;
}

describe('antigravity/server', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(streamResponse);
  });

  it('creates a CodeAssistServer so shared consumers keep working', () => {
    expect(createAntigravityServer(authClient, userData)).toBeInstanceOf(
      CodeAssistServer,
    );
  });

  it('passes the account data through to the server', () => {
    const config = { getSessionId: () => 'session-1' } as unknown as Config;
    const server = createAntigravityServer(
      authClient,
      userData,
      { headers: { 'X-Custom': 'yes' } },
      'session-1',
      config,
    );

    expect(server.projectId).toBe('antigravity-project');
    expect(server.userTier).toBe(UserTierId.FREE);
    expect(server.userTierName).toBe('Antigravity');
    expect(server.getEffectiveSessionId()).toBe('session-1');
    expect(server.config).toBe(config);
  });

  it('targets the Antigravity origin', () => {
    const server = createAntigravityServer(authClient, userData);

    expect(server.getMethodUrl('streamGenerateContent')).toBe(
      `${DEFAULT_ENDPOINT}/v1internal:streamGenerateContent`,
    );
    expect(server.getOperationUrl('operations/abc')).toBe(
      `${DEFAULT_ENDPOINT}/v1internal/operations/abc`,
    );
  });

  it('sends the Antigravity client fingerprint without dropping caller headers', async () => {
    const server = createAntigravityServer(authClient, userData, {
      headers: { 'X-Custom': 'yes' },
    });

    await drain(server);

    const options = requestMock.mock.calls[0][0] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': expect.stringContaining('antigravity/'),
      'X-Goog-Api-Client': 'antigravity-cli',
      'Client-Metadata': expect.stringContaining('ANTIGRAVITY'),
      'X-Custom': 'yes',
    });
  });

  it('adds the Antigravity envelope fields to streaming requests', async () => {
    const server = createAntigravityServer(
      authClient,
      userData,
      {},
      'session-1',
    );

    await drain(server);

    const body = JSON.parse(requestMock.mock.calls[0][0].body as string);
    expect(body).toMatchObject({
      project: 'antigravity-project',
      model: 'gemini-3-flash',
      user_prompt_id: 'prompt-1',
      requestType: 'agent',
      userAgent: 'antigravity',
    });
    expect(body.requestId).toMatch(
      /^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/1$/,
    );
    expect(body.request.labels).toEqual({
      last_step_index: '0',
      request_id: expect.stringMatching(/^[0-9a-f-]{36}-0$/),
      trajectory_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      used_claude: 'false',
      used_claude_conservative: 'false',
      used_non_gemini_model: 'false',
    });
    expect(body.request.sessionId).toMatch(/^-?\d+$/);
    // No last_execution_id on the opening turn.
    expect(body.request.labels).not.toHaveProperty('last_execution_id');
    expect(body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
  });

  it('keeps one trajectory across requests in a session', async () => {
    const server = createAntigravityServer(
      authClient,
      userData,
      {},
      'session-1',
    );

    await drain(server);
    await drain(server);

    const bodies = requestMock.mock.calls.map((call) =>
      JSON.parse(call[0].body as string),
    );
    expect(bodies[1].request.labels.trajectory_id).toBe(
      bodies[0].request.labels.trajectory_id,
    );
    // Each request carries its own inner session id.
    expect(bodies[1].request.sessionId).not.toBe(bodies[0].request.sessionId);
  });

  it('marks non-Gemini models in the labels', () => {
    const decorate = createAntigravityEnvelope('session-1');
    const decorated = decorate({
      model: 'claude-opus-4-6-thinking',
      request: { contents: [{}, {}] },
    }) as { request: { labels: Record<string, string> } };

    expect(decorated.request.labels).toMatchObject({
      used_claude: 'true',
      used_claude_conservative: 'true',
      used_non_gemini_model: 'true',
      last_step_index: '1',
      // Present from the second turn onwards.
      last_execution_id: expect.any(String),
    });
  });

  it('adds the Antigravity envelope fields to non-streaming requests', async () => {
    requestMock.mockResolvedValue({ data: { response: { candidates: [] } } });
    const server = createAntigravityServer(authClient, userData);

    await server.generateContent(
      { model: 'gemini-3-flash', contents: 'hello' },
      'prompt-1',
      LlmRole.MAIN,
    );

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${DEFAULT_ENDPOINT}/v1internal:generateContent`,
      }),
    );
    const body = JSON.parse(requestMock.mock.calls[0][0].body as string);
    expect(body).toMatchObject({
      requestType: 'agent',
      userAgent: 'antigravity',
    });
  });

  it('issues a unique request id per request', async () => {
    const server = createAntigravityServer(authClient, userData);

    await drain(server);
    await drain(server);

    const ids = requestMock.mock.calls.map(
      (call) => JSON.parse(call[0].body as string).requestId as string,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves the default Gemini Code Assist backend untouched', () => {
    const server = new CodeAssistServer(authClient, 'project');

    expect(server.getMethodUrl('generateContent')).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
    );
    expect(antigravityBackend().baseUrl).not.toBe(
      'https://cloudcode-pa.googleapis.com/v1internal',
    );
  });
});
