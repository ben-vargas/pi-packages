/**
 * Configuration constants for the Synthetic provider extension.
 * Single source of truth for API URLs, compat flags, and paths.
 */

export const SYNTHETIC_API_BASE_URL = "https://api.synthetic.new/openai/v1";
export const SYNTHETIC_MODELS_ENDPOINT = `${SYNTHETIC_API_BASE_URL}/models`;
export const SYNTHETIC_QUOTAS_ENDPOINT = "https://api.synthetic.new/v2/quotas";

/** Shared compat flags for all Synthetic models (OpenAI-compatible API). */
export const SYNTHETIC_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	supportsUsageInStreaming: false,
	supportsStore: false,
	maxTokensField: "max_tokens",
	requiresToolResultName: true,
} as const;

export const AUTH_JSON_PATH = "~/.pi/agent/auth.json";
