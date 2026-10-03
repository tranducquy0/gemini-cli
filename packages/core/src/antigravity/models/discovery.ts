import { fetchAvailableModelsCatalog, parseApiKey } from "../client/client.js";
import { buildAntigravityCatalog, type AntigravityCatalog } from "./grouping.js";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING } from "./models.js";

export async function discoverAntigravityModels(apiKey: string): Promise<AntigravityCatalog> {
  const creds = parseApiKey(apiKey);
  const available = await fetchAvailableModelsCatalog(creds.token, creds.projectId);
  const models = available.data.models;
  return buildAntigravityCatalog(models, { models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING });
}
