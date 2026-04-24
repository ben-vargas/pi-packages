import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import antigravityImageGen, { DEPRECATION_MESSAGE } from "../extensions/index.js";

const createMockPi = () =>
	({
		registerTool: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

describe("pi-antigravity-image-gen", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is deprecated and does not register tools", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const mockPi = createMockPi();
		antigravityImageGen(mockPi as unknown as ExtensionAPI);

		expect(mockPi.registerTool).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(DEPRECATION_MESSAGE);
	});
});
