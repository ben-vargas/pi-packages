import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import syntheticProvider, { getFallbackModels } from "../extensions/index.js";

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

	it("applies GLM-5.2 reasoning-effort overrides to live models only", async () => {
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
					data: [
						liveModel("hf:zai-org/GLM-5.2", "zai-org/GLM-5.2"),
						liveModel("hf:MiniMaxAI/MiniMax-M3", "MiniMaxAI/MiniMax-M3"),
					],
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		const glm = models.find((model) => model.id === "hf:zai-org/GLM-5.2");
		expect(glm).toMatchObject({ compat: { supportsReasoningEffort: true } });
		expect(glm?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "high",
			medium: "high",
			high: "high",
			xhigh: "max",
		});

		const minimax = models.find((model) => model.id === "hf:MiniMaxAI/MiniMax-M3");
		expect(minimax).toMatchObject({ compat: { supportsReasoningEffort: false } });
		expect(minimax?.thinkingLevelMap).toBeUndefined();
	});

	it("keeps GLM-5.2 reasoning enabled when the live catalog omits supported_features", async () => {
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
					data: [
						liveModel("hf:zai-org/GLM-5.2", "zai-org/GLM-5.2"),
						liveModel("hf:MiniMaxAI/MiniMax-M3", "MiniMaxAI/MiniMax-M3"),
					],
				}),
			}),
		);
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const models = mockPi.registerProvider.mock.calls[0]?.[1].models as ProviderModelConfig[];
		const glm = models.find((model) => model.id === "hf:zai-org/GLM-5.2");
		expect(glm).toMatchObject({ reasoning: true, compat: { supportsReasoningEffort: true } });

		const minimax = models.find((model) => model.id === "hf:MiniMaxAI/MiniMax-M3");
		expect(minimax).toMatchObject({ reasoning: false });
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
