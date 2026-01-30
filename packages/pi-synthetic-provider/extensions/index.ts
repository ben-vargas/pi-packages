/**
 * Synthetic Provider Extension
 *
 * Registers Synthetic (synthetic.new) as a model provider using their OpenAI-compatible API.
 * This extension provides full feature parity with native provider implementations.
 *
 * Features:
 * - Dynamic model fetching from Synthetic API (always-up-to-date model list)
 * - Automatic capability detection (reasoning, vision, tools)
 * - Proper cost calculation from API pricing data
 * - OpenAI Completions API compatibility (no custom streaming needed)
 * - Support for auth.json credential storage (in addition to env vars)
 *
 * Setup (choose one method):
 *
 *   Method 1 - Environment Variable (quick):
 *     export SYNTHETIC_API_KEY="syn_..."
 *     pi -e ./synthetic-provider.ts
 *
 *   Method 2 - Auth Storage (persistent, secure):
 *     # Add to ~/.pi/agent/auth.json:
 *     {
 *       "synthetic": {
 *         "type": "api_key",
 *         "key": "syn_your_api_key_here"
 *       }
 *     }
 *     pi -e ./synthetic-provider.ts
 *
 * Usage:
 *   # List available models
 *   pi /model
 *
 *   # Use specific model
 *   pi --model synthetic:hf:moonshotai/Kimi-K2.5
 *
 *   # Use default model
 *   pi --model synthetic
 *
 * Supported Models (as of 2026-01-29):
 * - hf:moonshotai/Kimi-K2.5 (reasoning + vision)
 * - hf:MiniMaxAI/MiniMax-M2.1 (reasoning)
 * - hf:zai-org/GLM-4.7 (reasoning)
 *
 * Note: Models are fetched dynamically from the API at session start, so the
 * available models list is always current.
 *
 * Developer Note: To update fallback pricing, run:
 *   curl -s https://api.synthetic.new/openai/v1/models | jq '.data[] | select(.always_on == true) | {id, name, provider, context_length, max_output_length, pricing}'
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Types
// =============================================================================

interface SyntheticModel {
	id: string;
	hugging_face_id: string;
	name: string;
	input_modalities: string[];
	output_modalities: string[];
	context_length: number;
	max_output_length: number;
	pricing: {
		prompt?: string;
		completion?: string;
		input_cache_reads?: string;
		input_cache_writes?: string;
	};
	supported_features?: string[];
	always_on?: boolean;
	provider?: string;
}

interface SyntheticModelsResponse {
	data: SyntheticModel[];
}

// =============================================================================
// Configuration
// =============================================================================

const SYNTHETIC_API_BASE_URL = "https://api.synthetic.new/openai/v1";
const SYNTHETIC_MODELS_ENDPOINT = `${SYNTHETIC_API_BASE_URL}/models`;

/** Shared compat flags for all Synthetic models (OpenAI-compatible API). */
const SYNTHETIC_COMPAT = {
	supportsDeveloperRole: false,
	supportsUsageInStreaming: false,
	supportsStore: false,
	requiresToolResultName: true,
} as const;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse pricing string to cost per million tokens.
 *
 * The Synthetic API returns pricing in two formats:
 * - Per-token: "$0.00000055" (most models) → multiply by 1M to get $/M
 * - Per-million: "$1.20" (e.g., Kimi-K2.5) → already in $/M format
 *
 * Heuristic: if the numeric value is < 0.001, it's per-token pricing.
 * Values >= 0.001 are already per-million.
 */
function parsePrice(price?: string): number {
	if (!price) return 0;
	const match = price.match(/[\d.]+/);
	if (!match) return 0;
	const value = parseFloat(match[0]);
	// Per-token values are tiny (e.g., 0.00000055); per-million values are >= 0.001
	return value < 0.001 ? value * 1_000_000 : value;
}

/**
 * Fetch models from Synthetic API and transform to ProviderModelConfig format.
 */
async function fetchSyntheticModels(apiKey?: string): Promise<ProviderModelConfig[]> {
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
		};

		// API key is optional for model listing (public endpoint)
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const response = await fetch(SYNTHETIC_MODELS_ENDPOINT, { headers });

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Failed to fetch models: ${response.status} ${response.statusText} - ${errorText}`);
		}

		const data = (await response.json()) as SyntheticModelsResponse;
		const models: ProviderModelConfig[] = [];

		for (const model of data.data) {
			// Only include always-on models.
			// Treat null/missing supported_features as "all features supported"
			// since the API only populates this field for Synthetic-hosted models.
			if (!model.always_on) continue;
			if (model.supported_features && !model.supported_features.includes("tools")) continue;

			const modelId = model.id; // e.g., "hf:moonshotai/Kimi-K2.5"
			const displayName = model.name || model.hugging_face_id || modelId;

			// Parse input modalities
			const input: ("text" | "image")[] = ["text"];
			if (model.input_modalities?.includes("image")) {
				input.push("image");
			}

			// Detect reasoning capability
			const reasoning = model.supported_features?.includes("reasoning") ?? false;

			models.push({
				id: modelId,
				name: displayName,
				reasoning,
				input,
				cost: {
					input: parsePrice(model.pricing?.prompt),
					output: parsePrice(model.pricing?.completion),
					cacheRead: parsePrice(model.pricing?.input_cache_reads),
					cacheWrite: parsePrice(model.pricing?.input_cache_writes),
				},
				contextWindow: model.context_length || 128000,
				maxTokens: model.max_output_length || 32768,
				compat: SYNTHETIC_COMPAT,
			});
		}

		return models;
	} catch (error) {
		console.error("[Synthetic Provider] Failed to fetch models:", error);
		// Return fallback models if API is unavailable
		return getFallbackModels();
	}
}

/**
 * Fallback models if API fetch fails.
 * Data sourced from: curl https://api.synthetic.new/openai/v1/models
 * Last updated: 2026-01-29
 *
 * Pricing format: $/million tokens
 * Most models: "$0.00000055" per token = $0.55 per million tokens
 * Kimi-K2.5: "$1.20" per million (already in per-M format)
 */
function getFallbackModels(): ProviderModelConfig[] {
	return [
		{
			id: "hf:moonshotai/Kimi-K2.5",
			name: "moonshotai/Kimi-K2.5",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.2,
				output: 1.2,
				cacheRead: 1.2,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: "hf:MiniMaxAI/MiniMax-M2.1",
			name: "MiniMaxAI/MiniMax-M2.1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.55,
				output: 2.19,
				cacheRead: 0.55,
				cacheWrite: 0,
			},
			contextWindow: 196608,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: "hf:zai-org/GLM-4.7",
			name: "zai-org/GLM-4.7",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.55,
				output: 2.19,
				cacheRead: 0.55,
				cacheWrite: 0,
			},
			contextWindow: 202752,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
	];
}

// =============================================================================
// Auth Configuration Helpers
// =============================================================================

const AUTH_JSON_PATH = "~/.pi/agent/auth.json";

/**
 * Check if Synthetic API key is available from any source.
 * Priority: auth.json > environment variable
 */
async function getSyntheticApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	// Check environment variable first (as fallback)
	const envKey = process.env.SYNTHETIC_API_KEY;

	// Try to get from modelRegistry (which checks auth.json)
	try {
		const authKey = await ctx.modelRegistry.getApiKeyForProvider("synthetic");
		if (authKey) return authKey;
	} catch {
		// Provider not registered yet, ignore
	}

	return envKey;
}

/**
 * Check if API key is configured (without retrieving it)
 * Uses getApiKeyForProvider which checks auth.json, env vars, etc.
 */
async function hasSyntheticApiKey(ctx: ExtensionContext): Promise<boolean> {
	// Check environment variable first (fast path)
	if (process.env.SYNTHETIC_API_KEY) return true;

	// Check via modelRegistry (checks auth.json, env vars, and other sources)
	try {
		const authKey = await ctx.modelRegistry.getApiKeyForProvider("synthetic");
		return !!authKey;
	} catch {
		// Provider not registered yet or other error
		return false;
	}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export { getFallbackModels, parsePrice };

export default function (pi: ExtensionAPI) {
	// Register provider synchronously with fallback models.
	// pi.registerProvider() during loading is queued and applied during
	// runner.initialize(). Registrations in event handlers (e.g., session_start)
	// are queued but never flushed, so the initial registration must happen here.
	pi.registerProvider("synthetic", {
		baseUrl: SYNTHETIC_API_BASE_URL,
		apiKey: "SYNTHETIC_API_KEY",
		api: "openai-completions",
		models: getFallbackModels(),
	});

	// After session starts, replace fallback models with live data from the API.
	// We use ctx.modelRegistry.registerProvider() directly because pi.registerProvider()
	// queues registrations that are only flushed during runner.initialize(), which has
	// already completed by the time session_start fires.
	pi.on("session_start", async (_event, ctx) => {
		const apiKey = await getSyntheticApiKey(ctx);
		const hasKey = await hasSyntheticApiKey(ctx);

		if (!hasKey) {
			console.log("[Synthetic Provider] API key not configured.");
			console.log("[Synthetic Provider] Options:");
			console.log("  1. Set SYNTHETIC_API_KEY environment variable");
			console.log(`  2. Add to ${AUTH_JSON_PATH} (see README for details)`);
		}

		// Fetch live models and register directly on the model registry
		const models = await fetchSyntheticModels(apiKey);

		if (models.length > 0) {
			ctx.modelRegistry.registerProvider("synthetic", {
				baseUrl: SYNTHETIC_API_BASE_URL,
				apiKey: "SYNTHETIC_API_KEY",
				api: "openai-completions",
				models,
			});
		} else {
			console.log("[Synthetic Provider] API unavailable, using fallback models");
		}
	});

	// Listen for model selection to provide helpful info
	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider === "synthetic") {
			const modelName = event.model.name || event.model.id;
			ctx.ui.notify(`Using Synthetic model: ${modelName}`, "info");
		}
	});

	// Register /synthetic-models command to display all available models
	pi.registerCommand("synthetic-models", {
		description: "Display all available Synthetic models with pricing and capabilities",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("[Synthetic Provider] /synthetic-models requires interactive mode");
				return;
			}

			ctx.ui.notify("Fetching model catalog from Synthetic API...", "info");

			try {
				const apiKey = await getSyntheticApiKey(ctx);
				const headers: Record<string, string> = {
					Accept: "application/json",
				};
				if (apiKey) {
					headers.Authorization = `Bearer ${apiKey}`;
				}

				const response = await fetch(SYNTHETIC_MODELS_ENDPOINT, { headers });

				if (!response.ok) {
					throw new Error(`API error: ${response.status} ${response.statusText}`);
				}

				const data = (await response.json()) as SyntheticModelsResponse;

				// Filter for always-on models
				const models = data.data.filter((m) => m.always_on);

				// Sort by provider then by name
				models.sort((a, b) => {
					const providerCompare = (a.provider || "unknown").localeCompare(b.provider || "unknown");
					if (providerCompare !== 0) return providerCompare;
					return a.name.localeCompare(b.name);
				});

				// Build table output (rendered in log area)
				ctx.ui.notify("Displaying model catalog in logs", "info");

				const W = 90;
				console.log(`\n${"=".repeat(W)}`);
				console.log("  SYNTHETIC MODEL CATALOG");
				console.log(`  ${models.length} models available`);
				console.log("=".repeat(W));

				// Group by provider
				const byProvider = new Map<string, SyntheticModel[]>();
				for (const m of models) {
					const provider = m.provider || "unknown";
					let bucket = byProvider.get(provider);
					if (!bucket) {
						bucket = [];
						byProvider.set(provider, bucket);
					}
					bucket.push(m);
				}

				// Display by provider
				for (const [provider, providerModels] of byProvider) {
					console.log("");
					console.log(`  ${provider.toUpperCase()} (${providerModels.length})`);
					console.log("-".repeat(W));

					// Table header
					const hdr = `  ${"Model".padEnd(44)}${"Ctx".padStart(5)}${"Input".padStart(8)}${"Output".padStart(8)}${"R-Cache".padStart(8)}  Caps`;
					console.log(hdr);
					console.log("-".repeat(W));

					for (const m of providerModels) {
						const id = m.id.length > 42 ? `${m.id.substring(0, 39)}...` : m.id;
						const context = `${(m.context_length / 1024).toFixed(0)}K`;
						const inputCost = `$${parsePrice(m.pricing?.prompt).toFixed(2)}`;
						const outputCost = `$${parsePrice(m.pricing?.completion).toFixed(2)}`;
						const cacheCost = `$${parsePrice(m.pricing?.input_cache_reads).toFixed(2)}`;

						const caps: string[] = [];
						if (m.input_modalities?.includes("image")) caps.push("vision");
						if (m.supported_features?.includes("reasoning")) caps.push("reason");
						if (m.supported_features?.includes("tools")) caps.push("tools");
						const capsStr = caps.length > 0 ? caps.join(", ") : "";

						console.log(
							`  ${id.padEnd(44)}${context.padStart(5)}${inputCost.padStart(8)}${outputCost.padStart(8)}${cacheCost.padStart(8)}  ${capsStr}`,
						);
					}
				}

				console.log("");
				console.log("=".repeat(W));
				console.log("  Prices are $/million tokens. R-Cache = input cache read cost.");
				console.log("  Use synthetic:<model-id> to select a model");
				console.log("  Example: pi --model synthetic:hf:moonshotai/Kimi-K2.5");
				console.log(`${"=".repeat(W)}\n`);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to fetch models: ${errorMessage}`, "error");
				console.error("[Synthetic Provider] Model listing failed:", error);
			}
		},
	});
}
