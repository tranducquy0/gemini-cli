/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Storage } from '../../config/storage.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { isRecord, asString } from '../utils/util.js';

/**
 * Antigravity credentials live in the same `~/.gemini/oauth_creds.json` file as
 * the OAuth tokens: the access/refresh token always comes from the live OAuth
 * client (which refreshes it transparently), so all we persist here is the
 * account metadata that cannot be re-derived offline (the Antigravity project).
 */
const ANTIGRAVITY_PROJECT_ID_KEY = 'antigravity_project_id';

export type CachedAntigravityAccount = {
  projectId: string;
};

function credsPath(): string {
  return Storage.getOAuthCredsPath();
}

async function readCredsFile(): Promise<Record<string, unknown>> {
  try {
    const contents = await fs.readFile(credsPath(), 'utf-8');
    const parsed: unknown = JSON.parse(contents);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return {};
    }
    debugLogger.debug('Failed to read cached Antigravity credentials', error);
    return {};
  }
}

export async function readCachedAntigravityAccount(): Promise<
  CachedAntigravityAccount | undefined
> {
  const creds = await readCredsFile();
  const projectId = asString(creds[ANTIGRAVITY_PROJECT_ID_KEY]);
  return projectId ? { projectId } : undefined;
}

export async function writeCachedAntigravityAccount(
  account: CachedAntigravityAccount,
): Promise<void> {
  const filePath = credsPath();
  const dirPath = path.dirname(filePath);

  // Re-read immediately before writing so a concurrent OAuth token refresh is
  // not clobbered by this narrower update.
  const creds = await readCredsFile();
  if (asString(creds[ANTIGRAVITY_PROJECT_ID_KEY]) === account.projectId) {
    return;
  }

  const contents = JSON.stringify(
    { ...creds, [ANTIGRAVITY_PROJECT_ID_KEY]: account.projectId },
    null,
    2,
  );

  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    debugLogger.debug('Failed to create credentials directory', error);
  }

  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.antigravity.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, contents, { mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    debugLogger.debug('Failed to cache Antigravity credentials', error);
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export async function clearCachedAntigravityAccount(): Promise<void> {
  const creds = await readCredsFile();
  if (!(ANTIGRAVITY_PROJECT_ID_KEY in creds)) return;
  delete creds[ANTIGRAVITY_PROJECT_ID_KEY];
  try {
    await fs.writeFile(credsPath(), JSON.stringify(creds, null, 2), {
      mode: 0o600,
    });
  } catch (error) {
    debugLogger.debug('Failed to clear Antigravity credentials', error);
  }
}
