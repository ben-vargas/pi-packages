import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piFirecrawlMcp from "../extensions/index.js";

const createMockPi = () =>
	({
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => undefined),
		registerTool: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

describe("pi-firecrawl-mcp", () => {
	it("registers tools", () => {
		const previousTools = process.env.FIRECRAWL_MCP_TOOLS;
		process.env.FIRECRAWL_MCP_TOOLS = "";

		const mockPi = createMockPi();
		piFirecrawlMcp(mockPi as unknown as ExtensionAPI);

		if (previousTools === undefined) {
			delete process.env.FIRECRAWL_MCP_TOOLS;
		} else {
			process.env.FIRECRAWL_MCP_TOOLS = previousTools;
		}

		const toolNames = mockPi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect(toolNames).toEqual(
			expect.arrayContaining([
				"firecrawl_scrape",
				"firecrawl_batch_scrape",
				"firecrawl_check_batch_status",
				"firecrawl_map",
				"firecrawl_search",
				"firecrawl_crawl",
				"firecrawl_check_crawl_status",
				"firecrawl_extract",
			]),
		);
	});

	it("registers flags", () => {
		const previousTools = process.env.FIRECRAWL_MCP_TOOLS;
		process.env.FIRECRAWL_MCP_TOOLS = "";

		const mockPi = createMockPi();
		piFirecrawlMcp(mockPi as unknown as ExtensionAPI);

		if (previousTools === undefined) {
			delete process.env.FIRECRAWL_MCP_TOOLS;
		} else {
			process.env.FIRECRAWL_MCP_TOOLS = previousTools;
		}

		const flagNames = mockPi.registerFlag.mock.calls.map(([name]) => name);
		expect(flagNames).toEqual(
			expect.arrayContaining([
				"--firecrawl-mcp-url",
				"--firecrawl-mcp-api-key",
				"--firecrawl-mcp-timeout-ms",
				"--firecrawl-mcp-protocol",
				"--firecrawl-mcp-config",
				"--firecrawl-mcp-tools",
				"--firecrawl-mcp-max-bytes",
				"--firecrawl-mcp-max-lines",
			]),
		);
	});
});
