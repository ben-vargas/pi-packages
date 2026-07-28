/**
 * Model fetching and fallback data for the Synthetic provider.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { SYNTHETIC_COMPAT, SYNTHETIC_MODELS_ENDPOINT } from "./config.js";
import { parsePrice } from "./formatting.js";
import type { SyntheticModelsResponse } from "./types.js";

export const GLM_5_2_MODEL_ID = "hf:zai-org/GLM-5.2";
export const GLM_4_7_FLASH_MODEL_ID = "hf:zai-org/GLM-4.7-Flash";
export const KIMI_K3_MODEL_ID = "hf:moonshotai/Kimi-K3";
export const QWEN_3_6_27B_MODEL_ID = "hf:Qwen/Qwen3.6-27B";
export const MINIMAX_M3_MODEL_ID = "hf:MiniMaxAI/MiniMax-M3";
export const NEMOTRON_3_SUPER_MODEL_ID = "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4";

/**
 * @deprecated Synthetic retired this model alongside the Kimi K3 launch, so it no
 * longer appears in the catalog, in the fallback list, or in the reasoning-effort
 * table. The constant is retained only so deep imports of `extensions/models.js`
 * keep resolving — `extensions/` ships in the published package. Use
 * {@link KIMI_K3_MODEL_ID}, or the `syn:large:vision` permalink, which Synthetic
 * re-pointed from this model to K3.
 */
export const KIMI_K27_CODE_MODEL_ID = "hf:moonshotai/Kimi-K2.7-Code";

type SyntheticModelOverrides = Pick<ProviderModelConfig, "compat"> &
	Partial<Pick<ProviderModelConfig, "reasoning" | "thinkingLevelMap">>;

/**
 * Per-model reasoning-effort support (https://github.com/ben-vargas/pi-packages/issues/21).
 *
 * Live Synthetic API probes verified which `reasoning_effort` values are accepted
 * and whether they engage reasoning. GLM-5.2, GLM-4.7-Flash, Qwen3.6-27B,
 * Nemotron, and Kimi-K3 map off to `none`; their `low` value also disables
 * reasoning, so pi's minimal and low levels are hidden. GLM-4.7-Flash and
 * Nemotron reject `max`, while GLM-5.2, Kimi-K3, and Qwen accept it for xhigh.
 *
 * Kimi-K3 supersedes Kimi-K2.7-Code here. K2.7-Code leaked raw thinking tags at
 * `none`/`low`, which forced its `off` level to stay hidden; K3 returns clean
 * content at both, so `off` is selectable. MiniMax reasons at every probed
 * value, so off is hidden and only its verified medium tier is exposed.
 * Relative depth between accepted tiers was not established. `null` hides a
 * level from pi's thinking-level cycling.
 *
 * `reasoning: true` is pinned because the live catalog may omit
 * `supported_features`; each override enables OpenAI-style reasoning effort.
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
		medium: "medium",
		high: "high",
		xhigh: "max",
	},
} satisfies SyntheticModelOverrides;

const GLM_4_7_FLASH_REASONING_OVERRIDES = {
	reasoning: true,
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: null,
	},
} satisfies SyntheticModelOverrides;

const KIMI_K3_REASONING_OVERRIDES = {
	reasoning: true,
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: "max",
	},
} satisfies SyntheticModelOverrides;

const QWEN_3_6_27B_REASONING_OVERRIDES = {
	reasoning: true,
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: "max",
	},
} satisfies SyntheticModelOverrides;

const MINIMAX_M3_REASONING_OVERRIDES = {
	reasoning: true,
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

const NEMOTRON_3_SUPER_REASONING_OVERRIDES = {
	reasoning: true,
	compat: {
		...SYNTHETIC_COMPAT,
		supportsReasoningEffort: true,
	},
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: null,
	},
} satisfies SyntheticModelOverrides;

const REASONING_OVERRIDES: Record<string, SyntheticModelOverrides> = {
	[GLM_5_2_MODEL_ID]: GLM_5_2_REASONING_OVERRIDES,
	[GLM_4_7_FLASH_MODEL_ID]: GLM_4_7_FLASH_REASONING_OVERRIDES,
	[KIMI_K3_MODEL_ID]: KIMI_K3_REASONING_OVERRIDES,
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
 * Last updated: 2026-07-28
 *
 * Mirrors the live `always_on` catalog. The `syn:*` permalinks are stable
 * aliases Synthetic re-points as models rotate; `syn:large:vision` now resolves
 * to Kimi K3 (was Kimi K2.7-Code, since retired) and `syn:large:text` to GLM 5.2.
 *
 * Pricing format: $/million tokens. `cacheRead` tracks the catalog's
 * `input_cache_reads` rate, which is well below the input rate on every model.
 */
export function getFallbackModels(): ProviderModelConfig[] {
	return [
		{
			id: "syn:large:text",
			name: "syn:large:text",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 1,
				output: 3,
				cacheRead: 0.16,
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
				cacheRead: 0.02,
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
				input: 3,
				output: 15,
				cacheRead: 0.45,
				cacheWrite: 0,
			},
			contextWindow: 524288,
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
				cacheRead: 0.09,
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
				cacheRead: 0.02,
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
				input: 1,
				output: 3,
				cacheRead: 0.16,
				cacheWrite: 0,
			},
			contextWindow: 524288,
			maxTokens: 65536,
			...getSyntheticModelOverrides(GLM_5_2_MODEL_ID),
		},
		{
			id: KIMI_K3_MODEL_ID,
			name: "moonshotai/Kimi-K3",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.45,
				cacheWrite: 0,
			},
			contextWindow: 524288,
			maxTokens: 65536,
			...getSyntheticModelOverrides(KIMI_K3_MODEL_ID),
		},
		{
			id: QWEN_3_6_27B_MODEL_ID,
			name: "Qwen/Qwen3.6-27B",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.45,
				output: 3.6,
				cacheRead: 0.09,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			...getSyntheticModelOverrides(QWEN_3_6_27B_MODEL_ID),
		},
		{
			id: MINIMAX_M3_MODEL_ID,
			name: "MiniMaxAI/MiniMax-M3",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.6,
				output: 1.2,
				cacheRead: 0.12,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			...getSyntheticModelOverrides(MINIMAX_M3_MODEL_ID),
		},
		{
			id: GLM_4_7_FLASH_MODEL_ID,
			name: "zai-org/GLM-4.7-Flash",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.02,
				cacheWrite: 0,
			},
			contextWindow: 196608,
			maxTokens: 65536,
			...getSyntheticModelOverrides(GLM_4_7_FLASH_MODEL_ID),
		},
		{
			id: NEMOTRON_3_SUPER_MODEL_ID,
			name: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.3,
				output: 1,
				cacheRead: 0.06,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			...getSyntheticModelOverrides(NEMOTRON_3_SUPER_MODEL_ID),
		},
	];
}
