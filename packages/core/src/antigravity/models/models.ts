export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";

export const ANTIGRAVITY_ROUTING: Record<string, any> = {
  "claude-opus-4-6": {
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  // ... (Simplified version for refactoring)
};

export const ANTIGRAVITY_MODELS: any[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Antigravity)",
  },
];

export function getAntigravityRequestModelId(modelId: string, effort: string | undefined): string {
    // Basic implementation
    return modelId;
}
