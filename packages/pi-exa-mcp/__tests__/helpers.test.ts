import { describe, expect, it } from "vitest";
import {
	normalizeTools,
	parseTimeoutMs,
	parseToolsFromUrl,
	resolveEffectiveLimits,
	resolveEndpoint,
	splitParams,
} from "../extensions/index.js";

describe("pi-exa-mcp helpers", () => {
	it("normalizes tools from strings and arrays", () => {
		expect(normalizeTools("web_search_exa, , get_code_context_exa")).toEqual([
			"web_search_exa",
			"get_code_context_exa",
		]);
		expect(normalizeTools([" web_search_exa ", "", 123])).toEqual(["web_search_exa"]);
	});

	it("parses tools from URL", () => {
		const tools = parseToolsFromUrl("https://mcp.exa.ai/mcp?tools=web_search_exa,get_code_context_exa");
		expect(tools).toEqual(["web_search_exa", "get_code_context_exa"]);
	});

	it("splits params and clamps limits", () => {
		const { mcpArgs, requestedLimits } = splitParams({
			piMaxBytes: "100",
			piMaxLines: 5,
			query: "hello",
		});
		expect(mcpArgs).toEqual({ query: "hello" });
		expect(requestedLimits).toEqual({ maxBytes: 100, maxLines: 5 });

		const effective = resolveEffectiveLimits({ maxBytes: 200, maxLines: 2 }, { maxBytes: 120, maxLines: 10 });
		expect(effective).toEqual({ maxBytes: 120, maxLines: 2 });
	});

	it("resolves endpoint with tools and api key", () => {
		const endpoint = resolveEndpoint("https://mcp.exa.ai/mcp", ["a", "b"], "secret");
		const url = new URL(endpoint);
		expect(url.searchParams.get("tools")).toBe("a,b");
		expect(url.searchParams.get("exaApiKey")).toBe("secret");

		const existing = resolveEndpoint("https://mcp.exa.ai/mcp?tools=web_search_exa", ["x"], "secret");
		const existingUrl = new URL(existing);
		expect(existingUrl.searchParams.get("tools")).toBe("web_search_exa");
	});

	it("parses timeout values", () => {
		expect(parseTimeoutMs("250", 10)).toBe(250);
		expect(parseTimeoutMs("0", 10)).toBe(10);
	});
});
