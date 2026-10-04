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
import { antigravityBackend, createAntigravityServer } from './server.js';
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
      'User-Agent': expect.stringContaining('antigravity/'),
      'X-Goog-Api-Client': 'antigravity-cli',
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
    expect(body.requestId).toEqual(expect.stringMatching(/^agent-\d+-/));
    expect(body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
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
