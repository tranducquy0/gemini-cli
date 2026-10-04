/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Storage } from '../../config/storage.js';
import {
  clearCachedAntigravityAccount,
  readCachedAntigravityAccount,
  writeCachedAntigravityAccount,
} from './storage.js';

describe('antigravity/auth/storage', () => {
  let tempDir: string;
  let credsPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'antigravity-creds-'));
    credsPath = path.join(tempDir, 'oauth_creds.json');
    vi.spyOn(Storage, 'getOAuthCredsPath').mockReturnValue(credsPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when no credentials are cached', async () => {
    await expect(readCachedAntigravityAccount()).resolves.toBeUndefined();
  });

  it('caches the project alongside the OAuth tokens', async () => {
    writeFileSync(
      credsPath,
      JSON.stringify({ access_token: 'token', refresh_token: 'refresh' }),
    );

    await writeCachedAntigravityAccount({ projectId: 'antigravity-project' });

    const cached = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(cached).toEqual({
      access_token: 'token',
      refresh_token: 'refresh',
      antigravity_project_id: 'antigravity-project',
    });
    await expect(readCachedAntigravityAccount()).resolves.toEqual({
      projectId: 'antigravity-project',
    });
  });

  it('does not rewrite the file when the project is unchanged', async () => {
    await writeCachedAntigravityAccount({ projectId: 'antigravity-project' });
    const first = readFileSync(credsPath, 'utf-8');

    await writeCachedAntigravityAccount({ projectId: 'antigravity-project' });

    expect(readFileSync(credsPath, 'utf-8')).toBe(first);
  });

  it('clears the cached project but keeps the tokens', async () => {
    writeFileSync(
      credsPath,
      JSON.stringify({ refresh_token: 'refresh', antigravity_project_id: 'p' }),
    );

    await clearCachedAntigravityAccount();

    expect(JSON.parse(readFileSync(credsPath, 'utf-8'))).toEqual({
      refresh_token: 'refresh',
    });
    await expect(readCachedAntigravityAccount()).resolves.toBeUndefined();
  });

  it('ignores a malformed credentials file', async () => {
    writeFileSync(credsPath, 'not json');

    await expect(readCachedAntigravityAccount()).resolves.toBeUndefined();
  });
});
