import { describe, expect, it } from "vitest";
import {
	normalizeCrawlArgs,
	normalizeHeaders,
	normalizeTools,
	parseTimeoutMs,
	resolveEffectiveLimits,
	resolveEndpoint,
	splitParams,
} from "../extensions/index.js";

describe("pi-firecrawl-mcp helpers", () => {
	it("normalizes tools and headers", () => {
		expect(normalizeTools("firecrawl_scrape, , firecrawl_map")).toEqual(["firecrawl_scrape", "firecrawl_map"]);
		expect(normalizeTools([" firecrawl_scrape ", "", 123])).toEqual(["firecrawl_scrape"]);

		expect(normalizeHeaders({ Authorization: "Bearer x", count: 2 })).toEqual({ Authorization: "Bearer x" });
		expect(normalizeHeaders("nope")).toBeUndefined();
	});

	it("normalizes crawl args", () => {
		const withDiscovery = normalizeCrawlArgs("firecrawl_crawl", { maxDiscoveryDepth: 3, url: "https://a.com" });
		expect(withDiscovery).toEqual({ maxDepth: 3, url: "https://a.com" });

		const withMaxDepth = normalizeCrawlArgs("firecrawl_crawl", {
			maxDepth: 2,
			maxDiscoveryDepth: 9,
			url: "https://a.com",
		});
		expect(withMaxDepth).toEqual({ maxDepth: 2, url: "https://a.com" });

		const passthrough = normalizeCrawlArgs("firecrawl_map", { url: "https://a.com" });
		expect(passthrough).toEqual({ url: "https://a.com" });
	});

	it("splits params and clamps limits", () => {
		const { mcpArgs, requestedLimits } = splitParams({
			piMaxBytes: "100",
			piMaxLines: 5,
			url: "https://a.com",
		});
		expect(mcpArgs).toEqual({ url: "https://a.com" });
		expect(requestedLimits).toEqual({ maxBytes: 100, maxLines: 5 });

		const effective = resolveEffectiveLimits({ maxBytes: 200, maxLines: 2 }, { maxBytes: 120, maxLines: 10 });
		expect(effective).toEqual({ maxBytes: 120, maxLines: 2 });
	});

	it("resolves endpoint and parses timeout", () => {
		const endpoint = resolveEndpoint("https://api.firecrawl.dev/{FIRECRAWL_API_KEY}/mcp", "secret");
		expect(endpoint).toBe("https://api.firecrawl.dev/secret/mcp");
		expect(parseTimeoutMs("250", 10)).toBe(250);
		expect(parseTimeoutMs("0", 10)).toBe(10);
	});
});
