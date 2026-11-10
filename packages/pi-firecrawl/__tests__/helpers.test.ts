import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildApiUrl,
	CONFIG_FILENAME,
	DEFAULT_CONFIG_FILE,
	ensureDefaultConfigFile,
	formatResponse,
	migrateLegacyArgs,
	normalizeHeaders,
	normalizeNumber,
	normalizeTools,
	parseTimeoutMs,
	resolveEffectiveLimits,
	splitParams,
} from "../extensions/index.js";

describe("pi-firecrawl helpers", () => {
	it("normalizes tools from string and array", () => {
		expect(normalizeTools("firecrawl_scrape, , firecrawl_map")).toEqual(["firecrawl_scrape", "firecrawl_map"]);
		expect(normalizeTools([" firecrawl_scrape ", "", 123])).toEqual(["firecrawl_scrape"]);
		expect(normalizeTools("")).toBeUndefined();
		expect(normalizeTools([])).toBeUndefined();
		expect(normalizeTools(42)).toBeUndefined();
	});

	it("normalizes headers", () => {
		expect(normalizeHeaders({ Authorization: "Bearer x", count: 2 })).toEqual({ Authorization: "Bearer x" });
		expect(normalizeHeaders("nope")).toBeUndefined();
		expect(normalizeHeaders({})).toBeUndefined();
	});

	it("normalizes numbers", () => {
		expect(normalizeNumber(42)).toBe(42);
		expect(normalizeNumber("100")).toBe(100);
		expect(normalizeNumber("abc")).toBeUndefined();
		expect(normalizeNumber(undefined)).toBeUndefined();
		expect(normalizeNumber(Number.NaN)).toBeUndefined();
	});

	it("splits params and clamps limits", () => {
		const { apiArgs, requestedLimits } = splitParams({
			piMaxBytes: "100",
			piMaxLines: 5,
			url: "https://a.com",
		});
		expect(apiArgs).toEqual({ url: "https://a.com" });
		expect(requestedLimits).toEqual({ maxBytes: 100, maxLines: 5 });

		const effective = resolveEffectiveLimits({ maxBytes: 200, maxLines: 2 }, { maxBytes: 120, maxLines: 10 });
		expect(effective).toEqual({ maxBytes: 120, maxLines: 2 });
	});

	it("parses timeout", () => {
		expect(parseTimeoutMs("250", 10)).toBe(250);
		expect(parseTimeoutMs("0", 10)).toBe(10);
		expect(parseTimeoutMs(undefined, 30000)).toBe(30000);
		expect(parseTimeoutMs("abc", 5000)).toBe(5000);
		expect(parseTimeoutMs(100, 10)).toBe(100);
	});

	it("writes default config when none exists", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-firecrawl-config-"));
		const projectConfigPath = join(base, "project", ".pi", "extensions", CONFIG_FILENAME);
		const globalConfigPath = join(base, "global", "extensions", CONFIG_FILENAME);

		ensureDefaultConfigFile([projectConfigPath, globalConfigPath], globalConfigPath);

		expect(existsSync(globalConfigPath)).toBe(true);
		const raw = readFileSync(globalConfigPath, "utf-8");
		expect(JSON.parse(raw)).toEqual(DEFAULT_CONFIG_FILE);
	});

	it("does not seed a default when another candidate (e.g. a legacy config) exists", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-firecrawl-config-"));
		const projectConfigPath = join(base, "project", ".pi", "extensions", CONFIG_FILENAME);
		const globalConfigPath = join(base, "global", "extensions", CONFIG_FILENAME);
		const legacyConfigPath = join(base, "legacy", "extensions", CONFIG_FILENAME);
		mkdirSync(join(base, "legacy", "extensions"), { recursive: true });
		writeFileSync(legacyConfigPath, JSON.stringify({ apiKey: "fc-legacy" }), "utf-8");

		ensureDefaultConfigFile([projectConfigPath, globalConfigPath, legacyConfigPath], globalConfigPath);

		expect(existsSync(globalConfigPath)).toBe(false);
	});

	it("does not overwrite existing config", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-firecrawl-config-"));
		const projectConfigPath = join(base, "project", ".pi", "extensions", CONFIG_FILENAME);
		const globalConfigPath = join(base, "global", "extensions", CONFIG_FILENAME);

		// First call creates it
		ensureDefaultConfigFile([projectConfigPath, globalConfigPath], globalConfigPath);
		const firstContent = readFileSync(globalConfigPath, "utf-8");

		// Second call should not overwrite
		ensureDefaultConfigFile([projectConfigPath, globalConfigPath], globalConfigPath);
		const secondContent = readFileSync(globalConfigPath, "utf-8");

		expect(firstContent).toBe(secondContent);
	});

	it("warns once and stops retrying when the default config write fails", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const base = mkdtempSync(join(tmpdir(), "pi-firecrawl-config-"));
			// A file where a directory is needed makes mkdirSync fail.
			const blocker = join(base, "blocker");
			writeFileSync(blocker, "not a directory", "utf-8");
			const projectConfigPath = join(base, "project", ".pi", "extensions", CONFIG_FILENAME);
			const globalConfigPath = join(blocker, "extensions", CONFIG_FILENAME);

			ensureDefaultConfigFile([projectConfigPath, globalConfigPath], globalConfigPath);
			expect(existsSync(globalConfigPath)).toBe(false);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`Failed to write ${globalConfigPath}`));

			// Removing the blocker would let a retry succeed. The latch must prevent the
			// retry entirely, not merely silence the second warning.
			rmSync(blocker);
			ensureDefaultConfigFile([projectConfigPath, globalConfigPath], globalConfigPath);
			expect(existsSync(globalConfigPath)).toBe(false);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("builds v2 URLs and only drops a pasted version on the hosted API", () => {
		expect(buildApiUrl("https://api.firecrawl.dev", "/scrape")).toBe("https://api.firecrawl.dev/v2/scrape");
		expect(buildApiUrl("https://api.firecrawl.dev/", "/map")).toBe("https://api.firecrawl.dev/v2/map");
		expect(buildApiUrl("https://api.firecrawl.dev/v1", "/search")).toBe("https://api.firecrawl.dev/v2/search");
		expect(buildApiUrl("https://api.firecrawl.dev/v2/", "/scrape")).toBe("https://api.firecrawl.dev/v2/scrape");
		// Self-hosted roots are used as given: a version-like host or mount path is not an API version.
		expect(buildApiUrl("http://localhost:3002", "/scrape")).toBe("http://localhost:3002/v2/scrape");
		expect(buildApiUrl("http://v1", "/scrape")).toBe("http://v1/v2/scrape");
		expect(buildApiUrl("https://proxy.example/firecrawl/v1", "/scrape")).toBe(
			"https://proxy.example/firecrawl/v1/v2/scrape",
		);
	});

	it("migrates v1 scrape arguments to v2", () => {
		expect(
			migrateLegacyArgs("firecrawl_scrape", {
				url: "https://a.com",
				formats: ["markdown", "screenshot@fullPage", "extract"],
				extract: { systemPrompt: "Be terse.", prompt: "Get the title", schema: { type: "object" } },
				parsePDF: false,
				geolocation: { country: "DE" },
				__experimental_cache: true,
			}),
		).toEqual({
			url: "https://a.com",
			formats: [
				"markdown",
				{ type: "screenshot", fullPage: true },
				{ type: "json", prompt: "Be terse.\n\nGet the title", schema: { type: "object" } },
			],
			parsers: [],
			location: { country: "DE" },
		});

		// v2-shaped arguments pass through untouched.
		const v2Args = { url: "https://a.com", formats: ["markdown", { type: "json", prompt: "x" }], maxAge: 0 };
		expect(migrateLegacyArgs("firecrawl_scrape", v2Args)).toEqual(v2Args);
	});

	it("drops v1-only extraction fields that the strict v2 format objects reject", () => {
		const jsonOptions = { mode: "llm", temperature: 0, prompt: "Get the title", schema: { type: "object" } };
		const expected = { type: "json", schema: { type: "object" }, prompt: "Get the title" };

		expect(migrateLegacyArgs("firecrawl_scrape", { url: "https://a.com", formats: ["json"], jsonOptions })).toEqual({
			url: "https://a.com",
			formats: [expected],
		});
		expect(
			migrateLegacyArgs("firecrawl_search", {
				query: "q",
				limit: 1,
				scrapeOptions: { formats: ["json"], jsonOptions },
			}),
		).toMatchObject({ scrapeOptions: { formats: [expected] } });
		expect(
			migrateLegacyArgs("firecrawl_scrape", {
				url: "https://a.com",
				formats: ["markdown", "changeTracking"],
				changeTrackingOptions: { modes: ["git-diff"], tag: "prod", unknown: true },
			}),
		).toEqual({
			url: "https://a.com",
			formats: ["markdown", { type: "changeTracking", modes: ["git-diff"], tag: "prod" }],
		});
	});

	it("migrates v1 map arguments to v2", () => {
		expect(
			migrateLegacyArgs("firecrawl_map", { url: "https://a.com", ignoreSitemap: true, maxDepth: 2, limit: 10 }),
		).toEqual({ url: "https://a.com", sitemap: "skip", limit: 10 });
		expect(migrateLegacyArgs("firecrawl_map", { url: "https://a.com", sitemapOnly: true })).toEqual({
			url: "https://a.com",
			sitemap: "only",
		});
		expect(migrateLegacyArgs("firecrawl_map", { url: "https://a.com", sitemap: "include", sitemapOnly: true })).toEqual(
			{
				url: "https://a.com",
				sitemap: "include",
			},
		);
	});

	it("migrates v1 search arguments to v2 and keeps v1-sized defaults", () => {
		expect(
			migrateLegacyArgs("firecrawl_search", {
				query: "pi agent",
				lang: "en",
				scrapeOptions: { formats: ["screenshot@fullPage"] },
			}),
		).toEqual({
			query: "pi agent",
			lang: "en",
			limit: 5,
			highlights: false,
			scrapeOptions: { formats: [{ type: "screenshot", fullPage: true }] },
		});
		expect(migrateLegacyArgs("firecrawl_search", { query: "pi agent", limit: 20, highlights: true })).toEqual({
			query: "pi agent",
			limit: 20,
			highlights: true,
		});
	});

	it("formats v2 map link objects as one URL per line", () => {
		expect(
			formatResponse("firecrawl_map", {
				success: true,
				links: [{ url: "https://a.com/", title: "A" }, { url: "https://a.com/docs" }, "https://a.com/legacy"],
			}),
		).toBe("https://a.com/\nhttps://a.com/docs\nhttps://a.com/legacy");
	});

	it("formats v2 search results grouped by source", () => {
		const data = { web: [{ url: "https://a.com", title: "A", description: "d" }] };
		expect(JSON.parse(formatResponse("firecrawl_search", { success: true, data }))).toEqual(data);
	});
});
