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
 * Supported Models (as of 2026-02-10):
 * - hf:moonshotai/Kimi-K2.5 (reasoning + vision)
 * - hf:nvidia/Kimi-K2.5-NVFP4 (reasoning + vision, NVIDIA FP4 variant)
 * - hf:MiniMaxAI/MiniMax-M2.1 (reasoning)
 * - hf:zai-org/GLM-4.7 (reasoning)
 *
 * Note: Models are fetched dynamically from the API at session start, so the
 * available models list is always current.
 *
 * Developer Note: To update fallback pricing, run:
 *   curl -s https://api.synthetic.new/openai/v1/models | jq '.data[] | select(.always_on == true) | {id, name, provider, context_length, max_output_length, pricing}'
 */

import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import { Box, Container, type SelectItem, SelectList, type SelectListTheme, Spacer, Text } from "@mariozechner/pi-tui";

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
	datacenters?: { country_code: string }[];
}

interface SyntheticModelsResponse {
	data: SyntheticModel[];
}

interface QuotaBucket {
	limit: number;
	requests: number;
	renewsAt: string;
}

interface SyntheticQuotaResponse {
	subscription?: QuotaBucket;
	search?: {
		hourly?: QuotaBucket;
	};
	freeToolCalls?: QuotaBucket;
	toolCallDiscounts?: QuotaBucket;
}

// =============================================================================
// Configuration
// =============================================================================

const SYNTHETIC_API_BASE_URL = "https://api.synthetic.new/openai/v1";
const SYNTHETIC_MODELS_ENDPOINT = `${SYNTHETIC_API_BASE_URL}/models`;
const SYNTHETIC_QUOTAS_ENDPOINT = "https://api.synthetic.new/v2/quotas";

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

function formatPrice(price?: string): string {
	return `$${parsePrice(price).toFixed(2)}`;
}

function formatContextTokens(tokens?: number): string {
	if (!tokens || tokens <= 0) return "n/a";
	return `${Math.round(tokens / 1024)}K`;
}

function formatTokenCount(tokens?: number): string {
	if (!tokens || tokens <= 0) return "n/a";
	return `${tokens.toLocaleString()} tokens`;
}

function truncateWithEllipsis(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (text.length <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	return `${text.slice(0, maxWidth - 1)}…`;
}

const REGION_DISPLAY_NAMES = (() => {
	try {
		return new Intl.DisplayNames(["en"], { type: "region" });
	} catch {
		return undefined;
	}
})();

function formatCountryCode(countryCode: string): string {
	const code = countryCode.trim().toUpperCase();
	if (!code) return "";
	const name = REGION_DISPLAY_NAMES?.of(code);
	if (!name || name === code) return code;
	return `${name} (${code})`;
}

function formatDatacenters(datacenters?: { country_code: string }[]): string {
	if (!datacenters || datacenters.length === 0) return "n/a";
	const names = datacenters.map((dc) => formatCountryCode(dc.country_code)).filter((name) => name.length > 0);
	return names.length > 0 ? names.join(", ") : "n/a";
}

function getModelCapabilities(model: SyntheticModel): string[] {
	const caps: string[] = [];
	if (model.input_modalities?.includes("image")) caps.push("vision");
	if (model.supported_features?.includes("reasoning")) caps.push("reason");
	if (model.supported_features?.includes("tools")) caps.push("tools");
	return caps;
}

function getProviderSortRank(provider?: string): number {
	return provider === "synthetic" ? 0 : 1;
}

const CATALOG_PROVIDER_COL = 10;
const CATALOG_MODEL_COL = 34;
const CATALOG_CTX_COL = 5;
const CATALOG_PRICE_COL = 7;
const CATALOG_CAPS_COL = 18;

function formatCatalogHeader(): string {
	const provider = "Provider".padEnd(CATALOG_PROVIDER_COL);
	const model = "Model".padEnd(CATALOG_MODEL_COL);
	const ctx = "Ctx".padStart(CATALOG_CTX_COL);
	const input = "In".padStart(CATALOG_PRICE_COL);
	const output = "Out".padStart(CATALOG_PRICE_COL);
	const cache = "R-Cache".padStart(CATALOG_PRICE_COL);
	const caps = "Caps".padEnd(CATALOG_CAPS_COL);
	return `${provider} ${model} ${ctx} ${input} ${output} ${cache} ${caps}`;
}

function formatCatalogRow(model: SyntheticModel): string {
	const providerRaw = model.provider || "unknown";
	const provider = truncateWithEllipsis(providerRaw, CATALOG_PROVIDER_COL).padEnd(CATALOG_PROVIDER_COL);
	const modelId = truncateWithEllipsis(model.id, CATALOG_MODEL_COL).padEnd(CATALOG_MODEL_COL);
	const ctx = formatContextTokens(model.context_length).padStart(CATALOG_CTX_COL);
	const input = formatPrice(model.pricing?.prompt).padStart(CATALOG_PRICE_COL);
	const output = formatPrice(model.pricing?.completion).padStart(CATALOG_PRICE_COL);
	const cache = formatPrice(model.pricing?.input_cache_reads).padStart(CATALOG_PRICE_COL);
	const capsRaw = getModelCapabilities(model).join("/") || "-";
	const caps = truncateWithEllipsis(capsRaw, CATALOG_CAPS_COL).padEnd(CATALOG_CAPS_COL);
	return `${provider} ${modelId} ${ctx} ${input} ${output} ${cache} ${caps}`;
}

// =============================================================================
// Quota Helpers
// =============================================================================

/**
 * Fetch quota information from the Synthetic API.
 * Requires an API key (returns null if not provided).
 */
async function fetchSyntheticQuota(apiKey: string): Promise<SyntheticQuotaResponse> {
	const response = await fetch(SYNTHETIC_QUOTAS_ENDPOINT, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Quota API error: ${response.status} ${response.statusText} - ${errorText}`);
	}

	return (await response.json()) as SyntheticQuotaResponse;
}

/**
 * Format a time remaining string from a renewal date.
 * Returns e.g. "2h 14m", "45m", "< 1m"
 */
function formatTimeRemaining(renewsAt: string): string {
	const now = Date.now();
	const renewalTime = new Date(renewsAt).getTime();
	const diffMs = renewalTime - now;

	if (diffMs <= 0) return "now";

	const totalMinutes = Math.floor(diffMs / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return "< 1m";
}

/**
 * Build a text-based progress bar.
 * @param used - number of requests used
 * @param limit - maximum requests allowed
 * @param barWidth - character width of the bar (excluding brackets)
 */
function buildProgressBar(used: number, limit: number, barWidth: number): { bar: string; percent: number } {
	const percent = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
	const filled = Math.round((percent / 100) * barWidth);
	const empty = barWidth - filled;
	const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
	return { bar, percent };
}

/**
 * Determine a color name based on usage percentage.
 */
function getUsageColor(percent: number): "success" | "warning" | "error" {
	if (percent < 60) return "success";
	if (percent < 85) return "warning";
	return "error";
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
 * Last updated: 2026-02-10
 *
 * Pricing format: $/million tokens
 * Synthetic-hosted models:
 * - Kimi-K2.5 & NVFP4: $0.55 input, $2.19 output, 262K context
 * - GLM-4.7: $0.55 input, $2.19 output, 202K context
 */
function getFallbackModels(): ProviderModelConfig[] {
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

export { buildProgressBar, fetchSyntheticQuota, formatTimeRemaining, getFallbackModels, getUsageColor, parsePrice };

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
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish before switching models", "warning");
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
				const models = data.data.filter((m) => m.always_on);

				// Sort with Synthetic-hosted models first, then provider/name
				models.sort((a, b) => {
					const rankCompare = getProviderSortRank(a.provider) - getProviderSortRank(b.provider);
					if (rankCompare !== 0) return rankCompare;

					const providerCompare = (a.provider || "unknown").localeCompare(b.provider || "unknown");
					if (providerCompare !== 0) return providerCompare;

					return (a.name || a.id).localeCompare(b.name || b.id);
				});

				if (models.length === 0) {
					ctx.ui.notify("No always-on models returned by Synthetic API", "warning");
					return;
				}

				const itemToModel = new Map<string, SyntheticModel>();
				const items: SelectItem[] = models.map((m) => {
					const provider = m.provider || "unknown";
					const itemKey = `${provider}:${m.id}`;
					itemToModel.set(itemKey, m);

					return {
						value: itemKey,
						label: formatCatalogRow(m),
					};
				});

				let overlayRows = 44;
				let overlayCols = 140;

				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						overlayRows = tui.terminal.rows;
						overlayCols = tui.terminal.columns;

						const selectTheme: SelectListTheme = {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						};

						const listMaxVisible = Math.max(6, Math.min(14, overlayRows - 24));
						const selectList = new SelectList(items, Math.min(items.length, listMaxVisible), selectTheme);
						const detailsText = new Text("", 1, 0);

						const updateDetails = (model: SyntheticModel | undefined) => {
							if (!model) {
								detailsText.setText(theme.fg("muted", "No model selected"));
								return;
							}

							const provider = model.provider || "unknown";
							const caps = getModelCapabilities(model);
							const datacenters = formatDatacenters(model.datacenters);

							const lines = [
								theme.fg("accent", theme.bold("Selected model")),
								`${theme.fg("muted", "ID:")} ${model.id}`,
								`${theme.fg("muted", "Provider:")} ${provider}`,
								`${theme.fg("muted", "Context:")} ${formatContextTokens(model.context_length)} (${formatTokenCount(model.context_length)})`,
								`${theme.fg("muted", "Max output:")} ${formatContextTokens(model.max_output_length)} (${formatTokenCount(model.max_output_length)})`,
								`${theme.fg("muted", "Pricing ($/M):")} in ${formatPrice(model.pricing?.prompt)} · out ${formatPrice(model.pricing?.completion)} · cache ${formatPrice(model.pricing?.input_cache_reads)}`,
								`${theme.fg("muted", "Capabilities:")} ${caps.length > 0 ? caps.join(", ") : "none"}`,
								`${theme.fg("muted", "Datacenters:")} ${datacenters}`,
								"",
								`${theme.fg("muted", "Use with:")} synthetic:${model.id}`,
							];
							detailsText.setText(lines.join("\n"));
						};

						const initial = items[0];
						updateDetails(initial ? itemToModel.get(initial.value) : undefined);

						selectList.onSelectionChange = (item) => {
							updateDetails(itemToModel.get(item.value));
							tui.requestRender();
						};

						selectList.onSelect = (item) => {
							void (async () => {
								const selected = itemToModel.get(item.value);
								if (!selected) return;

								const modelRef = `synthetic:${selected.id}`;
								const registryModel = ctx.modelRegistry.find("synthetic", selected.id);
								if (!registryModel) {
									ctx.ui.notify(
										`Model ${modelRef} is not currently registered in pi (possibly unsupported for tools)`,
										"warning",
									);
									return;
								}

								const switched = await pi.setModel(registryModel);
								if (!switched) {
									ctx.ui.notify(`No API key available for ${modelRef}`, "error");
									return;
								}

								ctx.ui.notify(`Switched model to ${modelRef}`, "info");
								done(undefined);
							})();
						};

						selectList.onCancel = () => done(undefined);

						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold("Synthetic Model Catalog")), 1, 0));
						container.addChild(
							new Text(
								theme.fg(
									"muted",
									`${models.length} always-on models · prices shown are $/million tokens · R-Cache = input cache read`,
								),
								1,
								0,
							),
						);
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", formatCatalogHeader()), 1, 0));
						container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));
						container.addChild(selectList);
						container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));
						container.addChild(new Spacer(1));
						container.addChild(detailsText);
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", "↑↓ navigate · Enter switches active model · Esc closes"), 1, 0),
						);
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						const panel = new Box(0, 0, (s: string) => theme.bg("customMessageBg", s));
						panel.addChild(container);

						return {
							render: (width) => panel.render(width),
							invalidate: () => panel.invalidate(),
							handleInput: (data) => {
								selectList.handleInput(data);
								tui.requestRender();
							},
						};
					},
					{
						overlay: true,
						overlayOptions: () => {
							const width = overlayCols < 120 ? "98%" : "96%";

							if (overlayRows < 34) {
								return {
									width: "100%",
									maxHeight: "94%",
									anchor: "center" as const,
									margin: 0,
								};
							}

							if (overlayRows < 44) {
								return {
									width,
									maxHeight: "88%",
									anchor: "bottom-center" as const,
									offsetY: -4,
									margin: 1,
								};
							}

							if (overlayRows < 54) {
								return {
									width,
									maxHeight: "82%",
									anchor: "bottom-center" as const,
									offsetY: -9,
									margin: 1,
								};
							}

							return {
								width,
								maxHeight: "78%",
								anchor: "bottom-center" as const,
								offsetY: -14,
								margin: 1,
							};
						},
					},
				);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to fetch models: ${errorMessage}`, "error");
				console.error("[Synthetic Provider] Model listing failed:", error);
			}
		},
	});

	// Register /synthetic-quota command to display current API usage quotas
	pi.registerCommand("synthetic-quota", {
		description: "Display your Synthetic API usage quotas and limits",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("[Synthetic Provider] /synthetic-quota requires interactive mode");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish", "warning");
				return;
			}

			const apiKey = await getSyntheticApiKey(ctx);
			if (!apiKey) {
				ctx.ui.notify("Synthetic API key not configured. Set SYNTHETIC_API_KEY or add to auth.json.", "error");
				return;
			}

			ctx.ui.notify("Fetching quota from Synthetic API...", "info");

			try {
				const quota = await fetchSyntheticQuota(apiKey);

				const BAR_WIDTH = 30;
				let overlayRows = 44;
				let overlayCols = 140;

				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						overlayRows = tui.terminal.rows;
						overlayCols = tui.terminal.columns;

						// API has moved tool-call quota from `toolCallDiscounts` to `freeToolCalls`;
						// keep both for backwards compatibility with older payloads.
						const toolCallBucket = quota.toolCallDiscounts ?? quota.freeToolCalls;
						// Count how many sections we'll render to estimate needed height
						const bucketCount = [quota.subscription, toolCallBucket, quota.search?.hourly].filter(Boolean).length;
						// Normal layout: ~7 lines/bucket + 3 separator lines between + 6 chrome
						// Compact layout: ~3 lines/bucket + 1 separator line between + 4 chrome
						const normalHeight = bucketCount * 7 + (bucketCount - 1) * 3 + 6;
						const compact = overlayRows < 45 || normalHeight > overlayRows * 0.75;
						const barWidth = compact ? 20 : BAR_WIDTH;

						const renderBucket = (label: string, bucket: QuotaBucket | undefined, icon: string): string[] => {
							if (!bucket) return [];

							const { bar, percent } = buildProgressBar(bucket.requests, bucket.limit, barWidth);
							const color = getUsageColor(percent);
							const remaining = Math.max(0, bucket.limit - bucket.requests);
							const renewalStr = formatTimeRemaining(bucket.renewsAt);

							if (compact) {
								return [
									`${icon}  ${theme.fg("accent", theme.bold(label))}`,
									`   ${theme.fg(color, bar)}  ${theme.fg(color, `${percent.toFixed(1)}%`)} used`,
									`   ${theme.bold(String(bucket.requests))} / ${bucket.limit} req ${theme.fg("muted", "·")} ${theme.fg(remaining > 0 ? "success" : "error", remaining.toFixed(1))} left ${theme.fg("muted", "·")} resets ${theme.fg("accent", renewalStr)}`,
								];
							}

							return [
								`${icon}  ${theme.fg("accent", theme.bold(label))}`,
								"",
								`   ${theme.fg(color, bar)}  ${theme.fg(color, `${percent.toFixed(1)}%`)} used`,
								"",
								`   ${theme.fg("muted", "Used:")}     ${theme.bold(String(bucket.requests))} / ${bucket.limit} requests`,
								`   ${theme.fg("muted", "Remaining:")} ${theme.fg(remaining > 0 ? "success" : "error", remaining.toFixed(1))} requests`,
								`   ${theme.fg("muted", "Resets in:")} ${theme.fg("accent", renewalStr)}`,
							];
						};

						const sections: string[][] = [];
						sections.push(renderBucket("Subscription", quota.subscription, "⚡"));
						if (toolCallBucket) {
							const toolCallLabel = quota.toolCallDiscounts ? "Tool Call Discounts" : "Free Tool Calls";
							sections.push(renderBucket(toolCallLabel, toolCallBucket, "🔧"));
						}
						if (quota.search?.hourly) {
							sections.push(renderBucket("Search (hourly)", quota.search.hourly, "🔍"));
						}

						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold("  Synthetic API Quota")), 1, 0));

						if (!compact) {
							container.addChild(
								new Text(theme.fg("muted", "  Usage and limits for your Synthetic subscription"), 1, 0),
							);
						}

						container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));

						if (!compact) {
							container.addChild(new Spacer(1));
						}

						for (let i = 0; i < sections.length; i++) {
							const section = sections[i];
							if (section.length > 0) {
								container.addChild(new Text(section.join("\n"), 1, 0));
								if (i < sections.length - 1) {
									if (!compact) {
										container.addChild(new Spacer(1));
									}
									container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));
								}
							}
						}

						if (!compact) {
							container.addChild(new Spacer(1));
						}
						container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));
						container.addChild(new Text(theme.fg("dim", "  Esc / Enter to close"), 1, 0));
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						const panel = new Box(0, 0, (s: string) => theme.bg("customMessageBg", s));
						panel.addChild(container);

						return {
							render: (width) => panel.render(width),
							invalidate: () => panel.invalidate(),
							handleInput: (data) => {
								if (data === "\x1b" || data === "\r" || data === "\n") {
									done(undefined);
								}
							},
						};
					},
					{
						overlay: true,
						overlayOptions: () => {
							const width = overlayCols < 100 ? "98%" : "70%";

							if (overlayRows < 30) {
								return {
									width: "100%",
									maxWidth: 80,
									minWidth: 50,
									maxHeight: "94%",
									anchor: "center" as const,
									margin: 0,
								};
							}

							if (overlayRows < 40) {
								return {
									width,
									maxWidth: 80,
									minWidth: 50,
									maxHeight: "88%",
									anchor: "top-center" as const,
									offsetY: 2,
									margin: 1,
								};
							}

							return {
								width,
								maxWidth: 80,
								minWidth: 50,
								maxHeight: "80%",
								anchor: "top-center" as const,
								offsetY: 4,
								margin: 1,
							};
						},
					},
				);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to fetch quota: ${errorMessage}`, "error");
				console.error("[Synthetic Provider] Quota fetch failed:", error);
			}
		},
	});
}
