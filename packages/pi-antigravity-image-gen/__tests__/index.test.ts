import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import antigravityImageGen from "../extensions/index.js";

const createMockPi = () =>
	({
		registerTool: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

describe("pi-antigravity-image-gen", () => {
	it("registers tools", () => {
		const mockPi = createMockPi();
		antigravityImageGen(mockPi as unknown as ExtensionAPI);

		const toolNames = mockPi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect(toolNames).toEqual(expect.arrayContaining(["generate_image", "image_quota"]));
	});
});
