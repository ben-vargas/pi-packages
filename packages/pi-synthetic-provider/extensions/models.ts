/**
 * Model fetching and fallback data for the Synthetic provider.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { SYNTHETIC_COMPAT, SYNTHETIC_MODELS_ENDPOINT } from "./config.js";
import { parsePrice } from "./formatting.js";
import type { SyntheticModelsResponse } from "./types.js";

export const GLM_5_2_MODEL_ID = "hf:zai-org/GLM-5.2";
export const GLM_4_7_FLASH_MODEL_ID = "hf:zai-org/GLM-4.7-Flash";
export const KIMI_K27_CODE_MODEL_ID = "hf:moonshotai/Kimi-K2.7-Code";
export const QWEN_3_6_27B_MODEL_ID = "hf:Qwen/Qwen3.6-27B";
export const MINIMAX_M3_MODEL_ID = "hf:MiniMaxAI/MiniMax-M3";
export const NEMOTRON_3_SUPER_MODEL_ID = "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4";

type SyntheticModelOverrides = Pick<ProviderModelConfig, "compat"> &
	Partial<Pick<ProviderModelConfig, "reasoning" | "thinkingLevelMap">>;

/**
 * Per-model reasoning-effort support (https://github.com/ben-vargas/pi-packages/issues/21).
 *
 * Synthetic's OpenAI-compatible API accepts `reasoning_effort` with values
 * "low", "medium", and "high". Some models only support a subset.
 * Setting a level to `null` hides it from pi's thinking-level cycling.
 *
 * GLM-5.2 has two effective tiers: `high` (lower) and an unset default that
 * falls through to `max` (highest). Synthetic's OpenAI shim rejects literal
 * `max`, so `xhigh` maps to `"medium"` which the GLM chat template treats as max.
 *
 * `reasoning: true` is pinned for GLM-5.2 because the live API may not populate
 * `supported_features` for proxied models; without the pin, the adapter would
 * silently skip effort emission.
 *
 * Each model's `compat` extends `SYNTHETIC_COMPAT` with `supportsReasoningEffort: true`
 * and any model-specific overrides (e.g. MiniMax uses `max_completion_tokens`).
 */

const GLM_5_2_REASONING_OVERRIDES = {
	reasoning: true,
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: "medium",
	},
} satisfies SyntheticModelOverrides;

const GLM_4_7_FLASH_REASONING_OVERRIDES = {
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
	},
} satisfies SyntheticModelOverrides;

const KIMI_K27_CODE_REASONING_OVERRIDES = {
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: null,
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
	},
} satisfies SyntheticModelOverrides;

const QWEN_3_6_27B_REASONING_OVERRIDES = {
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
	},
} satisfies SyntheticModelOverrides;

const MINIMAX_M3_REASONING_OVERRIDES = {
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
		maxTokensField: "max_completion_tokens",
	},
	thinkingLevelMap: {
		off: null,
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
	},
} satisfies SyntheticModelOverrides;

const NEMOTRON_3_SUPER_REASONING_OVERRIDES = {
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
	},
} satisfies SyntheticModelOverrides;

const REASONING_OVERRIDES: Record<string, SyntheticModelOverrides> = {
	[GLM_5_2_MODEL_ID]: GLM_5_2_REASONING_OVERRIDES,
	[GLM_4_7_FLASH_MODEL_ID]: GLM_4_7_FLASH_REASONING_OVERRIDES,
	[KIMI_K27_CODE_MODEL_ID]: KIMI_K27_CODE_REASONING_OVERRIDES,
	[QWEN_3_6_27B_MODEL_ID]: QWEN_3_6_27B_REASONING_OVERRIDES,
	[MINIMAX_M3_MODEL_ID]: MINIMAX_M3_REASONING_OVERRIDES,
	[NEMOTRON_3_SUPER_MODEL_ID]: NEMOTRON_3_SUPER_REASONING_OVERRIDES,
};

export function getSyntheticModelOverrides(modelId: string): SyntheticModelOverrides {
	const override = REASONING_OVERRIDES[modelId];
	if (override) {
		return override;
	}
	return { compat: SYNTHETIC_COMPAT };
}

export interface FetchSyntheticModelsOptions {
	timeoutMs?: number;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
	if (timeoutMs === undefined) {
		return fetch(url, init);
	}

	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort();
			reject(new Error(`Timed out fetching Synthetic models after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Fetch models from Synthetic API and transform to ProviderModelConfig format.
 */
export async function fetchSyntheticModels(
	apiKey?: string,
	options: FetchSyntheticModelsOptions = {},
): Promise<ProviderModelConfig[]> {
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
		};

		// API key is optional for model listing (public endpoint)
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const response = await fetchWithTimeout(SYNTHETIC_MODELS_ENDPOINT, { headers }, options.timeoutMs);

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
				...getSyntheticModelOverrides(modelId),
			});
		}

		if (models.length === 0) {
			console.warn("[Synthetic Provider] Live model catalog returned no supported models; using fallback models");
			return getFallbackModels();
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
 * Data sourced from: authenticated GET https://api.synthetic.new/openai/v1/models
 * Last updated: 2026-07-04
 *
 * Pricing format: $/million tokens
 */
export function getFallbackModels(): ProviderModelConfig[] {
	return [
		{
			id: "syn:large:text",
			name: "syn:large:text",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 1.4,
				output: 4.4,
				cacheRead: 1.4,
				cacheWrite: 0,
			},
			contextWindow: 524288,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: "syn:small:text",
			name: "syn:small:text",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.1,
				cacheWrite: 0,
			},
			contextWindow: 196608,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: "syn:large:vision",
			name: "syn:large:vision",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.95,
				output: 4,
				cacheRead: 0.95,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: "syn:small:vision",
			name: "syn:small:vision",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.45,
				output: 3.6,
				cacheRead: 0.45,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: "hf:openai/gpt-oss-120b",
			name: "openai/gpt-oss-120b",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.1,
				output: 0.1,
				cacheRead: 0.1,
				cacheWrite: 0,
			},
			contextWindow: 131072,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: GLM_5_2_MODEL_ID,
			name: "zai-org/GLM-5.2",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 1.4,
				output: 4.4,
				cacheRead: 1.4,
				cacheWrite: 0,
			},
			contextWindow: 524288,
			maxTokens: 65536,
			...getSyntheticModelOverrides(GLM_5_2_MODEL_ID),
		},
		{
			id: "hf:moonshotai/Kimi-K2.7-Code",
			name: "moonshotai/Kimi-K2.7-Code",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.95,
				output: 4,
				cacheRead: 0.95,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			...getSyntheticModelOverrides(KIMI_K27_CODE_MODEL_ID),
		},
		{
			id: "hf:Qwen/Qwen3.6-27B",
			name: "Qwen/Qwen3.6-27B",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.45,
				output: 3.6,
				cacheRead: 0.45,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			...getSyntheticModelOverrides(QWEN_3_6_27B_MODEL_ID),
		},
		{
			id: "hf:MiniMaxAI/MiniMax-M3",
			name: "MiniMaxAI/MiniMax-M3",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.6,
				output: 1.2,
				cacheRead: 0.6,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			...getSyntheticModelOverrides(MINIMAX_M3_MODEL_ID),
		},
		{
			id: "hf:zai-org/GLM-4.7-Flash",
			name: "zai-org/GLM-4.7-Flash",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.1,
				cacheWrite: 0,
			},
			contextWindow: 196608,
			maxTokens: 65536,
			...getSyntheticModelOverrides(GLM_4_7_FLASH_MODEL_ID),
		},
		{
			id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
			name: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.3,
				output: 1,
				cacheRead: 0.3,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			...getSyntheticModelOverrides(NEMOTRON_3_SUPER_MODEL_ID),
		},
	];
}
