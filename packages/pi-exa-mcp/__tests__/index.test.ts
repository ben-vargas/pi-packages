import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import exaMcp from "../extensions/index.js";

const createMockPi = () =>
	({
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => undefined),
		registerTool: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

describe("pi-exa-mcp", () => {
	it("registers tools", () => {
		const mockPi = createMockPi();
		exaMcp(mockPi as unknown as ExtensionAPI);

		const toolNames = mockPi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect(toolNames).toEqual(expect.arrayContaining(["web_search_exa", "get_code_context_exa"]));
	});

	it("registers flags", () => {
		const mockPi = createMockPi();
		exaMcp(mockPi as unknown as ExtensionAPI);

		const flagNames = mockPi.registerFlag.mock.calls.map(([name]) => name);
		expect(flagNames).toEqual(
			expect.arrayContaining([
				"--exa-mcp-url",
				"--exa-mcp-tools",
				"--exa-mcp-api-key",
				"--exa-mcp-timeout-ms",
				"--exa-mcp-protocol",
				"--exa-mcp-config",
				"--exa-mcp-max-bytes",
				"--exa-mcp-max-lines",
			]),
		);
	});
});
