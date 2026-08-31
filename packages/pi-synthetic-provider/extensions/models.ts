/**
 * Model fetching and fallback data for the Synthetic provider.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { SYNTHETIC_COMPAT, SYNTHETIC_MODELS_ENDPOINT } from "./config.js";
import { parsePrice } from "./formatting.js";
import type { SyntheticModel, SyntheticModelsResponse } from "./types.js";

export const GLM_5_3_FLASH_MODEL_ID = "hf:zai-org/GLM-5.3-Flash";
export const GLM_5_2_MODEL_ID = "hf:zai-org/GLM-5.2";
export const GLM_4_7_FLASH_MODEL_ID = "hf:zai-org/GLM-4.7-Flash";
export const GPT_OSS_120B_MODEL_ID = "hf:openai/gpt-oss-120b";
export const KIMI_K3_MODEL_ID = "hf:moonshotai/Kimi-K3";
export const QWEN_3_8_27B_MODEL_ID = "hf:Qwen/Qwen3.8-27B";
export const NEMOTRON_3_SUPER_MODEL_ID = "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4";

type SyntheticModelOverrides = Pick<ProviderModelConfig, "compat"> &
	Partial<Pick<ProviderModelConfig, "reasoning" | "thinkingLevelMap">>;
type SyntheticThinkingLevel = keyof NonNullable<ProviderModelConfig["thinkingLevelMap"]>;
type SyntheticReasoningEffort = "none" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_LEVELS: Record<SyntheticReasoningEffort, SyntheticThinkingLevel> = {
	none: "off",
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

function createReasoningOverrides(efforts: readonly SyntheticReasoningEffort[]): SyntheticModelOverrides;
function createReasoningOverrides(efforts: readonly string[]): SyntheticModelOverrides | undefined;
function createReasoningOverrides(efforts: readonly string[]): SyntheticModelOverrides | undefined {
	const thinkingLevelMap: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};
	let hasKnownEffort = false;

	for (const rawEffort of efforts) {
		if (typeof rawEffort !== "string") continue;
		const effort = rawEffort.trim();
		const level = REASONING_EFFORT_LEVELS[effort.toLowerCase() as SyntheticReasoningEffort];
		if (!level) continue;
		thinkingLevelMap[level] = effort;
		hasKnownEffort = true;
	}

	if (!hasKnownEffort) return undefined;
	return {
		reasoning: true,
		compat: {
			...SYNTHETIC_COMPAT,
			supportsReasoningEffort: true,
		},
		thinkingLevelMap,
	};
}

/**
 * Hardcoded reasoning-effort fallbacks for startup when the live catalog cannot
 * be fetched. Values mirror the authenticated catalog's
 * `reasoning_parameters.efforts`; live rows override these snapshots.
 *
 * Kimi K3 and GLM 5.3-Flash always reason and only accept `low`, `high`, and
 * `max`, so `off` is deliberately unavailable. Qwen 3.8-27B has no `none` either
 * and tops out at `xhigh`, so `off`, `high`, and `max` are unavailable.
 */
const GLM_5_3_FLASH_REASONING_OVERRIDES = createReasoningOverrides(["low", "high", "max"]);
const GLM_5_2_REASONING_OVERRIDES = createReasoningOverrides(["none", "high", "max"]);
const GLM_4_7_FLASH_REASONING_OVERRIDES = createReasoningOverrides(["none", "low", "medium", "high"]);
const GPT_OSS_120B_REASONING_OVERRIDES = createReasoningOverrides(["none", "low", "medium", "high"]);
const KIMI_K3_REASONING_OVERRIDES = createReasoningOverrides(["low", "high", "max"]);
const QWEN_3_8_27B_REASONING_OVERRIDES = createReasoningOverrides(["low", "medium", "xhigh"]);
const NEMOTRON_3_SUPER_REASONING_OVERRIDES = createReasoningOverrides(["none", "low", "medium", "high"]);

/**
 * A `Map` rather than a plain object: `REASONING_OVERRIDES[modelId]` on an object
 * literal resolves inherited keys, so a catalog id of `constructor` or `toString`
 * would return a truthy non-override and be spread into a model config.
 */
const REASONING_OVERRIDES = new Map<string, SyntheticModelOverrides>([
	[GLM_5_3_FLASH_MODEL_ID, GLM_5_3_FLASH_REASONING_OVERRIDES],
	[GLM_5_2_MODEL_ID, GLM_5_2_REASONING_OVERRIDES],
	[GLM_4_7_FLASH_MODEL_ID, GLM_4_7_FLASH_REASONING_OVERRIDES],
	[GPT_OSS_120B_MODEL_ID, GPT_OSS_120B_REASONING_OVERRIDES],
	[KIMI_K3_MODEL_ID, KIMI_K3_REASONING_OVERRIDES],
	[QWEN_3_8_27B_MODEL_ID, QWEN_3_8_27B_REASONING_OVERRIDES],
	[NEMOTRON_3_SUPER_MODEL_ID, NEMOTRON_3_SUPER_REASONING_OVERRIDES],
]);

/** Synthetic's rotating permalink ids, e.g. `syn:large:vision`. */
const PERMALINK_ID_PREFIX = "syn:";

/**
 * Resolve the reasoning-effort overrides for a catalog id.
 *
 * A live catalog row's `reasoning_parameters.efforts` is authoritative and is
 * converted into an exact pi thinking-level map. Unsupported levels are marked
 * `null`, so the selector only exposes values Synthetic says the route accepts.
 *
 * When live effort metadata is absent, pinned `hf:*` ids use the hardcoded
 * startup snapshots above. Permalink `syn:*` ids then resolve through the row's
 * `hugging_face_id`, which names their current target.
 *
 * Resolution fails closed. An explicit non-reasoning capability list, an empty
 * or unrecognized live effort list, or an unknown permalink target yields shared
 * compat and emits no `reasoning_effort`. Sending a rejected value can fail the
 * entire request, which is worse than using the server-side default.
 *
 * The `model` parameter is optional so existing single-argument callers — the
 * fallback catalog and any deep-import consumer — keep working unchanged.
 */
export function getSyntheticModelOverrides(modelId: string, model?: SyntheticModel): SyntheticModelOverrides {
	const declaresNoReasoning =
		model && Array.isArray(model.supported_features) && !model.supported_features.includes("reasoning");
	if (declaresNoReasoning) {
		return { compat: SYNTHETIC_COMPAT };
	}

	const advertisedEfforts = model?.reasoning_parameters?.efforts;
	if (Array.isArray(advertisedEfforts)) {
		return createReasoningOverrides(advertisedEfforts) ?? { compat: SYNTHETIC_COMPAT };
	}

	const direct = REASONING_OVERRIDES.get(modelId);
	if (direct) {
		return direct;
	}

	if (model && modelId.startsWith(PERMALINK_ID_PREFIX)) {
		const target = model.hugging_face_id;
		if (typeof target === "string" && target && !target.includes(":")) {
			const aliased = REASONING_OVERRIDES.get(`hf:${target}`);
			if (aliased) {
				return aliased;
			}
		}
	}

	return { compat: SYNTHETIC_COMPAT };
}

export interface FetchSyntheticModelsOptions {
	timeoutMs?: number;
	/**
	 * Receives fallback diagnostics instead of the console. Callers on a
	 * UI-attached path (e.g. session_start) must supply this: pi's fullscreen
	 * renderer repaints differentially, so stray console writes corrupt the
	 * frame. When omitted, diagnostics go to the console, which is only safe
	 * before the TUI starts (extension loading) or when no UI is attached.
	 */
	notify?: (message: string, level: "warning" | "error") => void;
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
				...getSyntheticModelOverrides(modelId, model),
			});
		}

		if (models.length === 0) {
			const message = "[Synthetic Provider] Live model catalog returned no supported models; using fallback models";
			if (options.notify) {
				options.notify(message, "warning");
			} else {
				console.warn(message);
			}
			return getFallbackModels();
		}

		return models;
	} catch (error) {
		if (options.notify) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			options.notify(`[Synthetic Provider] Failed to fetch models: ${errorMessage}`, "error");
		} else {
			console.error("[Synthetic Provider] Failed to fetch models:", error);
		}
		// Return fallback models if API is unavailable
		return getFallbackModels();
	}
}

/**
 * Fallback models if API fetch fails.
 * Data sourced from: authenticated GET https://api.synthetic.new/openai/v1/models
 * Model metadata last updated: 2026-08-30
 * Reasoning efforts last updated: 2026-08-30
 *
 * Mirrors the live `always_on` catalog. The `syn:*` permalinks are stable
 * aliases Synthetic re-points as models rotate: `syn:large:vision` resolves to
 * Kimi K3, `syn:large:text` to GLM 5.3-Flash, `syn:small:text` to GLM
 * 4.7-Flash, and `syn:small:vision` to Qwen 3.8-27B.
 *
 * Pricing format: $/million tokens. `cacheRead` tracks the catalog's
 * `input_cache_reads` rate, which is well below the input rate on every model.
 *
 * The `syn:*` entries deliberately carry no `thinkingLevelMap`. Offline there is
 * no catalog row naming the permalink's current target, so any effort map here
 * would be a guess that goes stale the moment Synthetic re-points the alias — and
 * a wrong map fails every request with HTTP 400 rather than merely running at the
 * default effort. Live discovery resolves permalinks properly via
 * `hugging_face_id`; see `getSyntheticModelOverrides`.
 */
export function getFallbackModels(): ProviderModelConfig[] {
	return [
		{
			id: "syn:large:text",
			name: "syn:large:text",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.15,
				output: 0.5,
				cacheRead: 0.04,
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
				output: 2.2,
				cacheRead: 0.09,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: GPT_OSS_120B_MODEL_ID,
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
			...getSyntheticModelOverrides(GPT_OSS_120B_MODEL_ID),
		},
		{
			id: GLM_5_3_FLASH_MODEL_ID,
			name: "zai-org/GLM-5.3-Flash",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.15,
				output: 0.5,
				cacheRead: 0.04,
				cacheWrite: 0,
			},
			contextWindow: 524288,
			maxTokens: 65536,
			...getSyntheticModelOverrides(GLM_5_3_FLASH_MODEL_ID),
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
			id: QWEN_3_8_27B_MODEL_ID,
			name: "Qwen/Qwen3.8-27B",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.45,
				output: 2.2,
				cacheRead: 0.09,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			...getSyntheticModelOverrides(QWEN_3_8_27B_MODEL_ID),
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
