export type AntigravityCatalog = {
  models: any[];
  routing: Record<string, any>;
};

export function buildAntigravityCatalog(
  rawModels: any,
  fallback: AntigravityCatalog,
): AntigravityCatalog {
  // Simple implementation
  return fallback;
}

export function resolvedCatalog(
  discovered: AntigravityCatalog | undefined,
  current: AntigravityCatalog,
): AntigravityCatalog {
  return discovered || current;
}
