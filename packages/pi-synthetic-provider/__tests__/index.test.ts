import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import syntheticProvider from "../extensions/index.js";

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
	vi.unstubAllGlobals();
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

	it("registers event listeners", async () => {
		stubModelsFetch();
		const mockPi = createMockPi();
		await syntheticProvider(mockPi as unknown as ExtensionAPI);

		const eventNames = mockPi.on.mock.calls.map(([name]) => name);
		expect(eventNames).toEqual(expect.arrayContaining(["session_start", "model_select"]));
	});
});
