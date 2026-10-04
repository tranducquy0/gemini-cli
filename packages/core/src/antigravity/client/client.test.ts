/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_ENDPOINT,
  PROD_ENDPOINT,
  antigravityHeaders,
  antigravityMethodUrl,
  describeAccountResponse,
  endpointCandidates,
  extractAccount,
  fetchAntigravityAccount,
  loadCodeAssist,
  parseApiKey,
} from './client.js';

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('antigravity/client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('endpointCandidates', () => {
    it('targets the Antigravity daily cluster first', () => {
      expect(endpointCandidates()).toEqual([DEFAULT_ENDPOINT, PROD_ENDPOINT]);
      expect(DEFAULT_ENDPOINT).toBe(
        'https://daily-cloudcode-pa.googleapis.com',
      );
    });

    it('honours an explicit override', () => {
      vi.stubEnv('ANTIGRAVITY_BASE_URL', 'https://example.test');
      expect(endpointCandidates()).toEqual(['https://example.test']);
    });

    it('ignores unprefixed environment variables', () => {
      vi.stubEnv('BASE_URL', '/');
      expect(endpointCandidates()).toEqual([DEFAULT_ENDPOINT, PROD_ENDPOINT]);
    });
  });

  describe('headers', () => {
    it('sends the Antigravity client fingerprint', () => {
      const headers = antigravityHeaders('token');

      expect(headers).toEqual({
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'User-Agent': expect.stringContaining('antigravity/'),
        'X-Goog-Api-Client': 'antigravity-cli',
        'Client-Metadata': expect.any(String),
      });
    });

    it('identifies the client as Antigravity', () => {
      expect(JSON.parse(antigravityHeaders()['Client-Metadata']!)).toEqual({
        ideType: 'ANTIGRAVITY',
        platform: expect.stringMatching(/^(MACOS|LINUX|WINDOWS)$/),
        pluginType: 'GEMINI',
      });
    });

    it('requests an event stream when streaming', () => {
      expect(
        antigravityHeaders(undefined, { accept: 'text/event-stream' })[
          'Accept'
        ],
      ).toBe('text/event-stream');
    });

    it('omits Authorization when no token is supplied', () => {
      expect(antigravityHeaders()).not.toHaveProperty('Authorization');
    });

    it('builds v1internal method urls', () => {
      expect(antigravityMethodUrl('https://host', 'loadCodeAssist')).toBe(
        'https://host/v1internal:loadCodeAssist',
      );
    });
  });

  describe('parseApiKey', () => {
    it('parses a JSON credential payload', () => {
      expect(
        parseApiKey(JSON.stringify({ token: 't', projectId: 'p' })),
      ).toEqual({ token: 't', projectId: 'p' });
    });

    it('throws when credentials are missing or malformed', () => {
      expect(() => parseApiKey(undefined)).toThrow(
        'No Antigravity OAuth credentials',
      );
      expect(() => parseApiKey('{"token":"t"}')).toThrow(
        'Invalid Antigravity credentials',
      );
    });
  });

  describe('extractAccount', () => {
    it('extracts the project and plan', () => {
      expect(
        extractAccount({
          currentTier: { id: 'free-tier', name: 'Antigravity' },
          paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
          cloudaicompanionProject: 'antigravity-project',
        }),
      ).toEqual({
        projectId: 'antigravity-project',
        tierId: 'free-tier',
        tierName: 'Antigravity',
        paidTierId: 'g1-pro-tier',
        paidTierName: 'Google AI Pro',
      });
    });

    it('reads a nested companion project', () => {
      expect(
        extractAccount({ cloudaicompanionProject: { id: 'nested' } }),
      ).toEqual({ projectId: 'nested' });
    });

    it('returns undefined for non-objects', () => {
      expect(extractAccount('nope')).toBeUndefined();
    });
  });

  describe('describeAccountResponse', () => {
    it('summarizes the plan fields without logging identifiers', () => {
      const summary = describeAccountResponse(
        'https://host',
        { projectId: 'voltaic-hangout-z1qhf', tierId: 'free-tier' },
        {
          cloudaicompanionProject: 'voltaic-hangout-z1qhf',
          currentTier: { id: 'free-tier', name: 'Antigravity' },
          gcpManaged: false,
        },
      );

      expect(summary).toContain('project=voltaic-hangout-z1qhf');
      expect(summary).toContain('tier=free-tier');
      expect(summary).toContain('paidTier=none');
      expect(summary).toContain('gcpManaged=false');
      expect(summary).toContain('currentTier');
    });

    it('describes a missing account', () => {
      expect(
        describeAccountResponse('https://host', undefined, 'nope'),
      ).toContain('project=none');
    });
  });

  describe('fetchAntigravityAccount', () => {
    it('resolves the account from loadCodeAssist', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          currentTier: { id: 'free-tier' },
          cloudaicompanionProject: 'antigravity-project',
        }),
      );

      await expect(fetchAntigravityAccount('token')).resolves.toEqual({
        projectId: 'antigravity-project',
        tierId: 'free-tier',
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${DEFAULT_ENDPOINT}/v1internal:loadCodeAssist`);
      expect(init.headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer token' }),
      );
      expect(JSON.parse(init.body as string)).toEqual({
        metadata: { ideType: 'ANTIGRAVITY' },
      });
    });

    it('falls back to the production endpoint', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 429));
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ projectId: 'antigravity-project' }),
      );

      await expect(loadCodeAssist('token')).resolves.toBe(
        'antigravity-project',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe(
        `${PROD_ENDPOINT}/v1internal:loadCodeAssist`,
      );
    });

    it('lists companion projects when loadCodeAssist omits the project', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ currentTier: {} }));
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ cloudaicompanionProject: 'listed-project' }),
      );

      await expect(fetchAntigravityAccount('token')).resolves.toEqual({
        projectId: 'listed-project',
      });
      expect(fetchMock.mock.calls[1][0]).toBe(
        `${DEFAULT_ENDPOINT}/v1internal:listCloudAICompanionProjects`,
      );
    });

    it('returns undefined when every endpoint fails', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));

      await expect(fetchAntigravityAccount('token')).resolves.toBeUndefined();
    });
  });
});
