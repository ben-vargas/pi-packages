import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piFirecrawl from "../extensions/index.js";

const createMockPi = () =>
	({
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => undefined),
		registerTool: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

describe("pi-firecrawl", () => {
	it("registers tools", () => {
		const previousTools = process.env.FIRECRAWL_TOOLS;
		process.env.FIRECRAWL_TOOLS = "";

		const mockPi = createMockPi();
		piFirecrawl(mockPi as unknown as ExtensionAPI);

		if (previousTools === undefined) {
			delete process.env.FIRECRAWL_TOOLS;
		} else {
			process.env.FIRECRAWL_TOOLS = previousTools;
		}

		const toolNames = mockPi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect(toolNames).toEqual(["firecrawl_scrape", "firecrawl_map", "firecrawl_search"]);
	});

	it("honors FIRECRAWL_TOOLS filtering", () => {
		const previousTools = process.env.FIRECRAWL_TOOLS;
		process.env.FIRECRAWL_TOOLS = "firecrawl_scrape,firecrawl_map";

		const mockPi = createMockPi();
		piFirecrawl(mockPi as unknown as ExtensionAPI);

		if (previousTools === undefined) {
			delete process.env.FIRECRAWL_TOOLS;
		} else {
			process.env.FIRECRAWL_TOOLS = previousTools;
		}

		const toolNames = mockPi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect(toolNames).toEqual(["firecrawl_scrape", "firecrawl_map"]);
	});

	it("registers flags", () => {
		const previousTools = process.env.FIRECRAWL_TOOLS;
		process.env.FIRECRAWL_TOOLS = "";

		const mockPi = createMockPi();
		piFirecrawl(mockPi as unknown as ExtensionAPI);

		if (previousTools === undefined) {
			delete process.env.FIRECRAWL_TOOLS;
		} else {
			process.env.FIRECRAWL_TOOLS = previousTools;
		}

		const flagNames = mockPi.registerFlag.mock.calls.map(([name]) => name);
		expect(flagNames).toEqual(
			expect.arrayContaining([
				"firecrawl-url",
				"firecrawl-api-key",
				"firecrawl-timeout-ms",
				"firecrawl-config",
				"firecrawl-tools",
				"firecrawl-max-bytes",
				"firecrawl-max-lines",
			]),
		);
		expect(flagNames.every((name) => !name.startsWith("--"))).toBe(true);
	});
});
