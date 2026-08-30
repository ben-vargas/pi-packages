import { readFileSync } from "node:fs";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import syntheticProvider, { getFallbackModels } from "../extensions/index.js";

const GLM_5_3_FLASH_MODEL_ID = "hf:zai-org/GLM-5.3-Flash";
const GLM_5_2_MODEL_ID = "hf:zai-org/GLM-5.2";
const KIMI_K3_MODEL_ID = "hf:moonshotai/Kimi-K3";
const NONE_LOW_MEDIUM_HIGH_MAP = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} as const;
const LOW_HIGH_MAX_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
const REASONING_MODEL_MAPS = {
	[GLM_5_3_FLASH_MODEL_ID]: LOW_HIGH_MAX_MAP,
	[GLM_5_2_MODEL_ID]: {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	},
	"hf:zai-org/GLM-4.7-Flash": NONE_LOW_MEDIUM_HIGH_MAP,
	"hf:openai/gpt-oss-120b": NONE_LOW_MEDIUM_HIGH_MAP,
	[KIMI_K3_MODEL_ID]: LOW_HIGH_MAX_MAP,
	"hf:Qwen/Qwen3.8-27B": {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: null,
		xhigh: "xhigh",
		max: null,
	},
	"hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4": NONE_LOW_MEDIUM_HIGH_MAP,
} as const;
const REASONING_MODEL_EFFORTS = {
	[GLM_5_3_FLASH_MODEL_ID]: ["low", "high", "max"],
	[GLM_5_2_MODEL_ID]: ["none", "high", "max"],
	"hf:zai-org/GLM-4.7-Flash": ["none", "low", "medium", "high"],
	"hf:openai/gpt-oss-120b": ["none", "low", "medium", "high"],
	[KIMI_K3_MODEL_ID]: ["low", "high", "max"],
	"hf:Qwen/Qwen3.8-27B": ["low", "medium", "xhigh"],
	"hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4": ["none", "low", "medium", "high"],
} as const;
const REASONING_MODEL_IDS = Object.keys(REASONING_MODEL_MAPS);

const createMockPi = () =>
	({
		registerProvider: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

const stubModelsFetch = () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [
					{
						id: "hf:zai-org/GLM-5.2",
						name: "zai-org/GLM-5.2",
						always_on: true,
						supported_features: ["tools", "reasoning"],
						input_modalities: ["text"],
						context_length: 524288,
						max_output_length: 65536,
						pricing: {
							prompt: "1",
							completion: "3",
						},
					},
				],
			}),
		}),
	);
};

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("pi-synthetic-provider", () => {
	it("declares direct Pi runtime imports as peer dependencies", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

		expect(manifest.peerDependencies).toMatchObject({
			"@earendil-works/pi-coding-agent": ">=0.77.0",
			"@earendil-works/pi-tui": ">=0.77.0",
		});
	});

	it("registers live startup provider and commands", async () => {
		stubModelsFetch();
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		expect(mockPi.registerProvider).toHaveBeenCalledWith(
			"synthetic",
			expect.objectContaining({
				api: "openai-completions",
				apiKey: "$SYNTHETIC_API_KEY",
				models: [expect.objectContaining({ id: "hf:zai-org/GLM-5.2" })],
			}),
		);
		expect(mockPi.registerCommand).toHaveBeenCalledWith(
			"synthetic-models",
			expect.objectContaining({ description: expect.any(String) }),
		);
		expect(mockPi.registerCommand).toHaveBeenCalledWith(
			"synthetic-quota",
			expect.objectContaining({ description: expect.any(String) }),
		);
	});

	it("derives exact reasoning-effort overrides from the live catalog", async () => {
		const liveModel = (id: string, name: string, efforts: readonly string[]) => ({
			id,
			name,
			always_on: true,
			supported_features: ["tools", "reasoning"],
			reasoning_parameters: { efforts },
			input_modalities: ["text"],
			context_length: 524288,
			max_output_length: 65536,
			pricing: { prompt: "1", completion: "3" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: REASONING_MODEL_IDS.map((id) =>
						liveModel(id, id, REASONING_MODEL_EFFORTS[id as keyof typeof REASONING_MODEL_EFFORTS]),
					),
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];

		for (const id of REASONING_MODEL_IDS) {
			const model = models.find((candidate) => candidate.id === id);
			expect(model).toMatchObject({ reasoning: true, compat: { supportsReasoningEffort: true } });
			expect(model?.thinkingLevelMap).toEqual(REASONING_MODEL_MAPS[id as keyof typeof REASONING_MODEL_MAPS]);
		}
	});

	it("lets live effort metadata override the hardcoded Kimi K3 fallback", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: [
						{
							id: KIMI_K3_MODEL_ID,
							name: "moonshotai/Kimi-K3",
							always_on: true,
							supported_features: ["tools", "reasoning"],
							reasoning_parameters: { efforts: ["low", "high"] },
							input_modalities: ["text", "image"],
							context_length: 524288,
							max_output_length: 65536,
							pricing: { prompt: "3", completion: "15" },
						},
					],
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		expect(models[0]?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("enables advertised efforts for newly discovered reasoning models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: [
						{
							id: "hf:example/new-reasoning-model",
							name: "example/new-reasoning-model",
							always_on: true,
							supported_features: ["tools", "reasoning"],
							reasoning_parameters: { efforts: ["none", "max"] },
							input_modalities: ["text"],
							context_length: 128000,
							max_output_length: 32768,
							pricing: { prompt: "1", completion: "3" },
						},
					],
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		expect(models[0]).toMatchObject({
			reasoning: true,
			compat: { supportsReasoningEffort: true },
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: "max",
			},
		});
	});

	it("resolves syn:* permalink overrides through the catalog target when effort metadata is absent", async () => {
		const permalinks = [
			["syn:large:text", "zai-org/GLM-5.3-Flash"],
			["syn:small:text", "zai-org/GLM-4.7-Flash"],
			["syn:large:vision", "moonshotai/Kimi-K3"],
			["syn:small:vision", "Qwen/Qwen3.8-27B"],
		] as const;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: permalinks.map(([id, huggingFaceId]) => ({
						id,
						name: id,
						hugging_face_id: huggingFaceId,
						always_on: true,
						supported_features: ["tools", "reasoning"],
						input_modalities: ["text"],
						context_length: 524288,
						max_output_length: 65536,
						pricing: { prompt: "1", completion: "3" },
					})),
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		for (const [id, huggingFaceId] of permalinks) {
			const model = models.find((candidate) => candidate.id === id);
			expect(model).toMatchObject({ reasoning: true, compat: { supportsReasoningEffort: true } });
			expect(model?.thinkingLevelMap).toEqual(
				REASONING_MODEL_MAPS[`hf:${huggingFaceId}` as keyof typeof REASONING_MODEL_MAPS],
			);
		}
	});

	it("leaves permalinks bare when the target cannot be resolved safely", async () => {
		// Each row fails closed for a different reason: unknown target, absent
		// target, an already-prefixed value, and an explicit non-reasoning
		// capability list that outranks the target's fallback map.
		const rows = [
			{ id: "syn:large:vision", hugging_face_id: "moonshotai/Kimi-K9", supported_features: ["tools", "reasoning"] },
			{ id: "syn:large:text", supported_features: ["tools", "reasoning"] },
			{ id: "syn:small:vision", hugging_face_id: "hf:Qwen/Qwen3.8-27B", supported_features: ["tools", "reasoning"] },
			{ id: "syn:small:text", hugging_face_id: "zai-org/GLM-4.7-Flash", supported_features: ["tools"] },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: rows.map((row) => ({
						...row,
						name: row.id,
						always_on: true,
						input_modalities: ["text"],
						context_length: 524288,
						max_output_length: 65536,
						pricing: { prompt: "1", completion: "3" },
					})),
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		for (const row of rows) {
			const model = models.find((candidate) => candidate.id === row.id);
			expect(model).toMatchObject({ compat: { supportsReasoningEffort: false } });
			expect(model?.thinkingLevelMap).toBeUndefined();
		}
	});

	it("does not alias a pinned hf: id through a mismatched catalog target", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: [
						{
							id: "hf:example/other-model",
							name: "example/other-model",
							hugging_face_id: "moonshotai/Kimi-K3",
							always_on: true,
							supported_features: ["tools", "reasoning"],
							input_modalities: ["text"],
							context_length: 131072,
							max_output_length: 65536,
							pricing: { prompt: "1", completion: "3" },
						},
					],
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		const model = models.find((candidate) => candidate.id === "hf:example/other-model");
		expect(model).toMatchObject({ compat: { supportsReasoningEffort: false } });
		expect(model?.thinkingLevelMap).toBeUndefined();
	});

	it("does not resolve inherited object keys as overrides", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: ["constructor", "toString", "__proto__"].map((id) => ({
						id,
						name: id,
						always_on: true,
						supported_features: ["tools", "reasoning"],
						input_modalities: ["text"],
						context_length: 131072,
						max_output_length: 65536,
						pricing: { prompt: "1", completion: "3" },
					})),
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		for (const model of models) {
			expect(model).toMatchObject({ compat: { supportsReasoningEffort: false } });
			expect(model?.thinkingLevelMap).toBeUndefined();
		}
	});

	it("keeps reasoning overrides enabled when the live catalog omits supported_features", async () => {
		const liveModel = (id: string, name: string) => ({
			id,
			name,
			always_on: true,
			input_modalities: ["text"],
			context_length: 524288,
			max_output_length: 65536,
			pricing: { prompt: "1", completion: "3" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: REASONING_MODEL_IDS.map((id) => liveModel(id, id)),
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		for (const id of REASONING_MODEL_IDS) {
			expect(models.find((model) => model.id === id)).toMatchObject({
				reasoning: true,
				compat: { supportsReasoningEffort: true },
			});
		}
	});

	it("registers event listeners", async () => {
		stubModelsFetch();
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const eventNames = mockPi.on.mock.calls.map(([name]) => name);
		expect(eventNames).toEqual(expect.arrayContaining(["session_start", "model_select"]));
	});

	describe("session_start handler", () => {
		let savedApiKey: string | undefined;

		beforeEach(() => {
			savedApiKey = process.env.SYNTHETIC_API_KEY;
			delete process.env.SYNTHETIC_API_KEY;
		});
		afterEach(() => {
			if (savedApiKey !== undefined) {
				process.env.SYNTHETIC_API_KEY = savedApiKey;
			} else {
				delete process.env.SYNTHETIC_API_KEY;
			}
		});

		const getSessionStartHandler = (mockPi: ReturnType<typeof createMockPi>) => {
			const call = mockPi.on.mock.calls.find(([name]) => name === "session_start");
			if (!call) throw new Error("session_start handler was not registered");
			return call[1] as (event: unknown, ctx: unknown) => Promise<void>;
		};

		const createSessionCtx = (overrides: { hasUI?: boolean } = {}) => ({
			hasUI: overrides.hasUI ?? true,
			ui: { notify: vi.fn() },
			modelRegistry: { getApiKeyForProvider: vi.fn().mockResolvedValue(undefined) },
		});

		it("notifies through the UI when no API key is configured and a UI is attached", async () => {
			stubModelsFetch();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const mockPi = createMockPi();
			await syntheticProvider(mockPi as unknown as ExtensionAPI);

			const ctx = createSessionCtx();
			await getSessionStartHandler(mockPi)(undefined, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not configured"), "warning");
			expect(logSpy).not.toHaveBeenCalled();
		});

		it("logs to the console when no API key is configured and no UI is attached", async () => {
			stubModelsFetch();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const mockPi = createMockPi();
			await syntheticProvider(mockPi as unknown as ExtensionAPI);

			const ctx = createSessionCtx({ hasUI: false });
			await getSessionStartHandler(mockPi)(undefined, ctx);

			expect(ctx.ui.notify).not.toHaveBeenCalled();
			expect(logSpy).toHaveBeenCalledWith("[Synthetic Provider] API key not configured.");
			expect(logSpy).toHaveBeenCalledWith("  2. Add to ~/.pi/agent/auth.json (see README for details)");
		});

		it("routes model fetch failures through the UI instead of the console", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("catalog down")));
			const mockPi = createMockPi();
			await syntheticProvider(mockPi as unknown as ExtensionAPI);
			// The startup fetch runs before any UI exists and keeps its console fallback.
			expect(errorSpy).toHaveBeenCalledTimes(1);
			errorSpy.mockClear();

			const ctx = createSessionCtx();
			await getSessionStartHandler(mockPi)(undefined, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("catalog down"), "error");
			expect(errorSpy).not.toHaveBeenCalled();
		});

		it("keeps console diagnostics for model fetch failures when no UI is attached", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("catalog down")));
			const mockPi = createMockPi();
			await syntheticProvider(mockPi as unknown as ExtensionAPI);
			errorSpy.mockClear();

			const ctx = createSessionCtx({ hasUI: false });
			await getSessionStartHandler(mockPi)(undefined, ctx);

			expect(ctx.ui.notify).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith("[Synthetic Provider] Failed to fetch models:", expect.any(Error));
		});
	});

	it("uses fallback startup models when the live catalog filters to empty", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ data: [{ id: "off-model", always_on: false }] }),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		expect(models).toEqual(getFallbackModels());
		expect(models.some((model) => model.id === "off-model")).toBe(false);
	});

	it("uses fallback startup models when the live fetch times out", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);
		const mockPi = createMockPi();
		const init = syntheticProvider(mockPi as unknown as ExtensionAPI);

		await vi.advanceTimersByTimeAsync(3000);
		await init;

		expect(mockPi.registerProvider.mock.calls[0]?.[1].models).toEqual(getFallbackModels());
	});
});
