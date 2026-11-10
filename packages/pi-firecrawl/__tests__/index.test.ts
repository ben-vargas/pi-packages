import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piFirecrawl, { CONFIG_FILENAME, DEFAULT_CONFIG_FILE } from "../extensions/index.js";

// The extension consults ~/.pi/agent as a legacy config fallback; point homedir at a
// temp dir so a developer's real config never leaks into the tests.
const mockedOs = vi.hoisted(() => ({ homedir: "" }));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => mockedOs.homedir };
});

const createMockPi = () =>
	({
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => undefined),
		registerTool: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

describe("pi-firecrawl", () => {
	// Point pi's agent dir at a temp dir so activation-time config seeding never
	// touches the real ~/.pi/agent, and so tests exercise the env override.
	let previousAgentDir: string | undefined;
	let previousConfigEnv: string | undefined;
	let agentDir: string;

	beforeEach(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		previousConfigEnv = process.env.FIRECRAWL_CONFIG;
		delete process.env.FIRECRAWL_CONFIG;
		agentDir = mkdtempSync(join(tmpdir(), "pi-firecrawl-agent-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mockedOs.homedir = mkdtempSync(join(tmpdir(), "pi-firecrawl-home-"));
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousConfigEnv === undefined) {
			delete process.env.FIRECRAWL_CONFIG;
		} else {
			process.env.FIRECRAWL_CONFIG = previousConfigEnv;
		}
	});

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

	it("seeds the default global config under PI_CODING_AGENT_DIR", () => {
		const previousTools = process.env.FIRECRAWL_TOOLS;
		process.env.FIRECRAWL_TOOLS = "";

		const mockPi = createMockPi();
		piFirecrawl(mockPi as unknown as ExtensionAPI);

		if (previousTools === undefined) {
			delete process.env.FIRECRAWL_TOOLS;
		} else {
			process.env.FIRECRAWL_TOOLS = previousTools;
		}

		const seededPath = join(agentDir, "extensions", CONFIG_FILENAME);
		expect(existsSync(seededPath)).toBe(true);
		expect(JSON.parse(readFileSync(seededPath, "utf-8"))).toEqual(DEFAULT_CONFIG_FILE);
	});

	it("falls back to the legacy global config when PI_CODING_AGENT_DIR relocates the agent dir", () => {
		const previousTools = process.env.FIRECRAWL_TOOLS;
		delete process.env.FIRECRAWL_TOOLS;

		const legacyExtensionsDir = join(mockedOs.homedir, ".pi", "agent", "extensions");
		mkdirSync(legacyExtensionsDir, { recursive: true });
		writeFileSync(join(legacyExtensionsDir, CONFIG_FILENAME), JSON.stringify({ tools: ["firecrawl_map"] }), "utf-8");

		const mockPi = createMockPi();
		piFirecrawl(mockPi as unknown as ExtensionAPI);

		if (previousTools === undefined) {
			delete process.env.FIRECRAWL_TOOLS;
		} else {
			process.env.FIRECRAWL_TOOLS = previousTools;
		}

		const toolNames = mockPi.registerTool.mock.calls.map(([tool]) => tool.name);
		expect(toolNames).toEqual(["firecrawl_map"]);

		// The legacy config must not be masked by seeding a default at the relocated path.
		expect(existsSync(join(agentDir, "extensions", CONFIG_FILENAME))).toBe(false);
	});

	it("routes invalid-config warnings through ctx.ui.notify when UI is attached", async () => {
		const previousTools = process.env.FIRECRAWL_TOOLS;
		process.env.FIRECRAWL_TOOLS = "";

		const base = mkdtempSync(join(tmpdir(), "pi-firecrawl-invalid-"));
		const configPath = join(base, CONFIG_FILENAME);
		writeFileSync(configPath, "{ not json", "utf-8");

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ success: true, data: "ok" }), { status: 200 }));

		try {
			const mockPi = {
				registerFlag: vi.fn(),
				getFlag: vi.fn((name: string) => (name === "firecrawl-config" ? configPath : undefined)),
				registerTool: vi.fn(),
			} satisfies Partial<ExtensionAPI>;
			piFirecrawl(mockPi as unknown as ExtensionAPI);

			// Activation has no extension context in scope, so it still warns on the console.
			expect(warnSpy).toHaveBeenCalledTimes(1);

			const scrape = mockPi.registerTool.mock.calls
				.map(([tool]) => tool)
				.find((tool) => tool.name === "firecrawl_scrape");
			const notify = vi.fn();
			const ctx = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;
			await scrape?.execute("call-1", { url: "https://example.com" }, undefined, undefined, ctx);

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining(`Invalid Firecrawl config at ${configPath}`),
				"warning",
			);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
			fetchSpy.mockRestore();
			if (previousTools === undefined) {
				delete process.env.FIRECRAWL_TOOLS;
			} else {
				process.env.FIRECRAWL_TOOLS = previousTools;
			}
		}
	});

	it("calls the v2 endpoints", async () => {
		const previousTools = process.env.FIRECRAWL_TOOLS;
		const previousUrl = process.env.FIRECRAWL_URL;
		process.env.FIRECRAWL_TOOLS = "";
		delete process.env.FIRECRAWL_URL;

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { web: [] } })));

		try {
			const mockPi = createMockPi();
			piFirecrawl(mockPi as unknown as ExtensionAPI);
			const ctx = { hasUI: false } as unknown as ExtensionContext;
			const calls: Record<string, Record<string, unknown>> = {
				firecrawl_scrape: { url: "https://example.com" },
				firecrawl_map: { url: "https://example.com" },
				firecrawl_search: { query: "example", lang: "en" },
			};
			for (const [tool] of mockPi.registerTool.mock.calls) {
				await tool.execute("call-1", calls[tool.name], undefined, undefined, ctx);
			}

			expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
				"https://api.firecrawl.dev/v2/scrape",
				"https://api.firecrawl.dev/v2/map",
				"https://api.firecrawl.dev/v2/search",
			]);
			const searchBody = JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body));
			expect(searchBody).toEqual({ query: "example", limit: 5 });
		} finally {
			fetchSpy.mockRestore();
			if (previousTools === undefined) delete process.env.FIRECRAWL_TOOLS;
			else process.env.FIRECRAWL_TOOLS = previousTools;
			if (previousUrl !== undefined) process.env.FIRECRAWL_URL = previousUrl;
		}
	});
});
