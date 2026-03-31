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
 * Supported Models (as of 2026-03-31):
 * - hf:moonshotai/Kimi-K2.5 (reasoning + vision)
 * - hf:nvidia/Kimi-K2.5-NVFP4 (reasoning + vision, NVIDIA FP4 variant)
 * - hf:MiniMaxAI/MiniMax-M2.1 (reasoning)
 * - hf:MiniMaxAI/MiniMax-M2.5 (reasoning + vision)
 * - hf:zai-org/GLM-5 (reasoning)
 * - hf:zai-org/GLM-4.7 (reasoning)
 *
 * Note: Models are fetched dynamically from the API at session start, so the
 * available models list is always current.
 *
 * Developer Note: To update fallback pricing, run:
 *   curl -s https://api.synthetic.new/openai/v1/models | jq '.data[] | select(.always_on == true) | {id, name, provider, context_length, max_output_length, pricing}'
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getSyntheticApiKey, hasSyntheticApiKey } from "./auth.js";
import { registerSyntheticModelsCommand } from "./commands/synthetic-models.js";
import { registerSyntheticQuotaCommand } from "./commands/synthetic-quota.js";
import { AUTH_JSON_PATH, SYNTHETIC_API_BASE_URL } from "./config.js";
import { fetchSyntheticModels, getFallbackModels } from "./models.js";

// Re-export public API for tests and consumers
export { parsePrice } from "./formatting.js";
export { getFallbackModels } from "./models.js";
export {
	buildProgressBar,
	fetchSyntheticQuota,
	formatTimeRemaining,
	getQuotaSystemLabel,
	getUsageColor,
	hasVisibleQuotaBucket,
	shouldDisplaySubscriptionQuota,
} from "./quota.js";

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
	// pi.registerProvider() now takes effect immediately after startup and also
	// lets the runtime refresh the current model reference if the provider config
	// changes beneath an already-selected model.
	pi.on("session_start", async (_event, ctx) => {
		const apiKey = await getSyntheticApiKey(ctx);
		const hasKey = await hasSyntheticApiKey(ctx);

		if (!hasKey) {
			console.log("[Synthetic Provider] API key not configured.");
			console.log("[Synthetic Provider] Options:");
			console.log("  1. Set SYNTHETIC_API_KEY environment variable");
			console.log(`  2. Add to ${AUTH_JSON_PATH} (see README for details)`);
		}

		// Fetch live models and update the runtime provider registration
		const models = await fetchSyntheticModels(apiKey);

		if (models.length > 0) {
			pi.registerProvider("synthetic", {
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

	// Register slash commands
	registerSyntheticModelsCommand(pi);
	registerSyntheticQuotaCommand(pi);
}
