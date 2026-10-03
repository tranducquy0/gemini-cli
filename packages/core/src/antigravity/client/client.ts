import { debugLogger } from "../../utils/debugLogger.js";

const fetch = globalThis.fetch; 

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

export async function antigravityFetch(url: string, options: RequestInit) {
  return fetch(url, options);
}
