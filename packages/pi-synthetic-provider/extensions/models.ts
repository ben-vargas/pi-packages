/**
 * Model fetching and fallback data for the Synthetic provider.
 */

import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { SYNTHETIC_COMPAT, SYNTHETIC_MODELS_ENDPOINT } from "./config.js";
import { parsePrice } from "./formatting.js";
import type { SyntheticModelsResponse } from "./types.js";

/**
 * Fetch models from Synthetic API and transform to ProviderModelConfig format.
 */
export async function fetchSyntheticModels(apiKey?: string): Promise<ProviderModelConfig[]> {
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
 * Last updated: 2026-02-25
 *
 * Pricing format: $/million tokens
 * Synthetic-hosted models:
 * - Kimi-K2.5 & NVFP4: $0.55 input, $2.19 output, 262K context
 * - MiniMax-M2.5: $0.60 input, $3.00 output, 191K context
 * - GLM-4.7: $0.55 input, $2.19 output, 202K context
 */
export function getFallbackModels(): ProviderModelConfig[] {
	return [
		{
			id: "hf:moonshotai/Kimi-K2.5",
			name: "moonshotai/Kimi-K2.5",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.55,
				output: 2.19,
				cacheRead: 0.55,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: "hf:nvidia/Kimi-K2.5-NVFP4",
			name: "nvidia/Kimi-K2.5-NVFP4",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.55,
				output: 2.19,
				cacheRead: 0.55,
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
				input: 0.3,
				output: 1.2,
				cacheRead: 0.3,
				cacheWrite: 0,
			},
			contextWindow: 196608,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		},
		{
			id: "hf:MiniMaxAI/MiniMax-M2.5",
			name: "MiniMaxAI/MiniMax-M2.5",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.6,
				output: 3,
				cacheRead: 0.6,
				cacheWrite: 0,
			},
			contextWindow: 191488,
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
