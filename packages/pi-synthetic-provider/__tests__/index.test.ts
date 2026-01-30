import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import syntheticProvider from "../extensions/index.js";

const createMockPi = () =>
	({
		registerProvider: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

describe("pi-synthetic-provider", () => {
	it("registers provider and command", () => {
		const mockPi = createMockPi();
		syntheticProvider(mockPi as unknown as ExtensionAPI);

		expect(mockPi.registerProvider).toHaveBeenCalledWith(
			"synthetic",
			expect.objectContaining({ api: "openai-completions" }),
		);
		expect(mockPi.registerCommand).toHaveBeenCalledWith(
			"synthetic-models",
			expect.objectContaining({ description: expect.any(String) }),
		);
	});

	it("registers event listeners", () => {
		const mockPi = createMockPi();
		syntheticProvider(mockPi as unknown as ExtensionAPI);

		const eventNames = mockPi.on.mock.calls.map(([name]) => name);
		expect(eventNames).toEqual(expect.arrayContaining(["session_start", "model_select"]));
	});
});
