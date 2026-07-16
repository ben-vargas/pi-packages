import { readFileSync } from "node:fs";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import syntheticProvider, { getFallbackModels } from "../extensions/index.js";

const GLM_5_2_MODEL_ID = "hf:zai-org/GLM-5.2";
const MINIMAX_M3_MODEL_ID = "hf:MiniMaxAI/MiniMax-M3";
const REASONING_MODEL_MAPS = {
	[GLM_5_2_MODEL_ID]: { off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: "max" },
	"hf:zai-org/GLM-4.7-Flash": {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: null,
	},
	"hf:moonshotai/Kimi-K2.7-Code": {
		off: null,
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: "max",
	},
	"hf:Qwen/Qwen3.6-27B": {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: "max",
	},
	[MINIMAX_M3_MODEL_ID]: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null },
	"hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4": {
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: null,
	},
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

	it("applies reasoning-effort overrides for all reasoning models in live fetch", async () => {
		const liveModel = (id: string, name: string) => ({
			id,
			name,
			always_on: true,
			supported_features: ["tools", "reasoning"],
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
			const model = models.find((candidate) => candidate.id === id);
			expect(model).toMatchObject({ reasoning: true, compat: { supportsReasoningEffort: true } });
			expect(model?.thinkingLevelMap).toEqual(REASONING_MODEL_MAPS[id as keyof typeof REASONING_MODEL_MAPS]);
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
