import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionAPI, keyHint, type MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piClaudeCodeUse, { _test } from "../extensions/index.js";

// Wrap keyHint in a spy that delegates to the real implementation. Outside
// pi's interactive TUI the real keyHint throws (uninitialized theme), which
// is exactly the fallback path most rendering tests exercise; individual
// tests override the return value to cover the resolved-binding path, since
// the real binding state lives in pi-coding-agent's own pi-tui instance and
// cannot be configured from here.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, keyHint: vi.fn(actual.keyHint) };
});

// ============================================================================
// Test helpers
// ============================================================================

/** Build a minimal ToolInfo-compatible object for test mocks. */
function mockTool(name: string, sourceOverrides?: { baseDir?: string; path?: string; description?: string }) {
	return {
		name,
		description: sourceOverrides?.description ?? "",
		parameters: {} as never,
		sourceInfo: {
			path: sourceOverrides?.path ?? "",
			source: "test",
			scope: "user" as const,
			origin: "package" as const,
			baseDir: sourceOverrides?.baseDir,
		},
	};
}

function createMockPi() {
	return {
		appendEntry: vi.fn(),
		events: {} as ExtensionAPI["events"],
		exec: vi.fn(),
		getActiveTools: vi.fn((): string[] => []),
		getAllTools: vi.fn((): ReturnType<ExtensionAPI["getAllTools"]> => []),
		getCommands: vi.fn(() => []),
		getFlag: vi.fn((_name?: string): boolean | string | undefined => undefined),
		getSessionName: vi.fn(() => undefined as string | undefined),
		getThinkingLevel: vi.fn(() => "medium"),
		on: vi.fn(),
		registerCommand: vi.fn(),
		registerFlag: vi.fn(),
		registerMarkdownTransformer: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerEntryRenderer: vi.fn(),
		registerProvider: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		setActiveTools: vi.fn(),
		setLabel: vi.fn(),
		setModel: vi.fn(async () => true),
		setSessionName: vi.fn(),
		setThinkingLevel: vi.fn(),
		unregisterProvider: vi.fn(),
	};
}

function getRegisteredHandler(pi: ReturnType<typeof createMockPi>, eventName: string) {
	const call = pi.on.mock.calls.find(([event]) => event === eventName);
	expect(call).toBeDefined();
	return call?.[1] as (event: unknown, ctx: Record<string, unknown>) => Promise<unknown>;
}

/** Run registerMcpAliases against an isolated (empty) config location. */
function registerAliasesIsolated(pi: ReturnType<typeof createMockPi>, tempDir: string) {
	_test.registerMcpAliases(pi as unknown as ExtensionAPI, {
		cwd: join(tempDir, "project"),
		agentDir: join(tempDir, "agent"),
	});
}

// ============================================================================
// Tests
// ============================================================================

describe("pi-claude-code-use", () => {
	beforeEach(() => {
		_test.registeredMcpAliases.clear();
		_test.autoActivatedAliases.clear();
		_test.aliasAssignments.clear();
		_test.registeredAliasRoutes.clear();
		_test.aliasSourceMeta.clear();
		_test.aliasExactNames.clear();
		_test.setLastManagedToolList(undefined);
		_test.refreshAliasMap([]);
	});

	// ----------------------------------------------------------------
	// Extension lifecycle
	// ----------------------------------------------------------------

	it("registers event hooks without overriding the anthropic provider", async () => {
		const pi = createMockPi();
		await piClaudeCodeUse(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("before_provider_request", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("message_end", expect.any(Function));
		expect(pi.registerProvider).not.toHaveBeenCalled();
	});

	it("does not call runtime-only APIs during extension factory load", async () => {
		const pi = createMockPi();
		pi.getAllTools.mockImplementation(() => {
			throw new Error("runtime not ready");
		});
		pi.getActiveTools.mockImplementation(() => {
			throw new Error("runtime not ready");
		});

		await expect(piClaudeCodeUse(pi as unknown as ExtensionAPI)).resolves.toBeUndefined();
	});

	it("uses the event cwd when loading project alias config", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "pi-claude-code-use-"));
		const projectDir = join(tempParent, "project");
		try {
			vi.stubEnv("PI_CODING_AGENT_DIR", join(tempParent, "agent"));
			const projectConfigPath = join(projectDir, ".pi", "extensions", "pi-claude-code-use.json");
			mkdirSync(dirname(projectConfigPath), { recursive: true });
			writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["subagent", "mcp__subagent__run"]] }));

			const pi = createMockPi();
			await piClaudeCodeUse(pi as unknown as ExtensionAPI);

			const ctx = { cwd: projectDir, model: undefined };
			const sessionStart = getRegisteredHandler(pi, "session_start");
			await sessionStart({ type: "session_start" }, ctx);
			expect(_test.FLAT_TO_MCP.get("subagent")).toBe("mcp__subagent__run");

			_test.refreshAliasMap([]);
			const beforeAgentStart = getRegisteredHandler(pi, "before_agent_start");
			await beforeAgentStart({ type: "before_agent_start", prompt: "", systemPrompt: "" }, ctx);
			expect(_test.FLAT_TO_MCP.get("subagent")).toBe("mcp__subagent__run");
		} finally {
			vi.unstubAllEnvs();
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	// ----------------------------------------------------------------
	// System prompt rewriting (PRD §1.1)
	// ----------------------------------------------------------------

	it("replaces 'pi itself' in string-form system prompts", () => {
		const result = _test.transformPayload(
			{
				system: "Pi docs (read about pi itself and its SDK):",
				messages: [{ role: "user", content: "hi" }],
			},
			false,
		);

		expect(result.system).toBe("Pi docs (read about the cli itself and its SDK):");
	});

	it("rewrites text blocks in array system prompts while preserving metadata", () => {
		const result = _test.transformPayload(
			{
				system: [
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
					{
						type: "text",
						text: "Pi docs (read about pi itself, its SDK, extensions):",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
				messages: [],
			},
			false,
		);

		expect(result.system).toEqual([
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
			{
				type: "text",
				text: "Pi docs (read about the cli itself, its SDK, extensions):",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		]);
	});

	it("leaves non-text system blocks untouched", () => {
		const guardBlock = { type: "guard_content", guard: "keep-me" };
		const result = _test.transformPayload(
			{
				system: [{ type: "text", text: "about pi itself" }, guardBlock],
				messages: [],
			},
			false,
		);

		expect(result.system).toEqual([{ type: "text", text: "about the cli itself" }, guardBlock]);
	});

	it("handles multiple occurrences of 'pi itself' in one block", () => {
		expect(_test.rewritePromptText("pi itself and pi itself again")).toBe("the cli itself and the cli itself again");
	});

	it("rewrites the additional Pi prompt tokens that trigger Anthropic filtering", () => {
		const prompt =
			"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n" +
			"- When asked about: custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)\n" +
			"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";

		expect(_test.rewritePromptText(prompt)).toBe(
			"Pi documentation (read only when the user asks about the cli itself, its SDK, extensions, themes, skills, or TUI):\n" +
				"- When asked about: custom providers (docs/custom-provider.md), adding models (docs/models.md), cli packages (docs/packages.md)\n" +
				"- Always read cli .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
		);
	});

	// ----------------------------------------------------------------
	// Tool filtering and MCP alias remapping (PRD §1.2)
	// ----------------------------------------------------------------

	it("passes core tools, typed tools, and mcp__-prefixed tools through", () => {
		const result = _test.transformPayload(
			{
				tools: [
					{ name: "Read", description: "Read files", input_schema: {} },
					{ type: "web_search", name: "web_search", search_context_size: "high" },
					{ name: "mcp__custom__lookup", description: "Custom", input_schema: {} },
					{ name: "unknown_flat_tool", description: "Should be dropped", input_schema: {} },
				],
				messages: [],
			},
			false,
		);

		const toolIds = (result.tools as { name?: string; type?: string }[]).map((t) => t.name ?? t.type);
		expect(toolIds).toEqual(["Read", "web_search", "mcp__custom__lookup"]);
	});

	it("renames aliased flat tools to MCP aliases when alias is advertised", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				tools: [
					{ name: "web_search_exa", description: "Current", input_schema: { v: 2 } },
					{
						name: "mcp__exa_mcp__web_search_exa",
						description: "Stale alias stub",
						input_schema: { v: 1 },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
				messages: [],
			},
			false,
		);

		expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual(["mcp__exa_mcp__web_search_exa"]);
		// The flat entry always carries the source tool's CURRENT schema, so the
		// renamed flat entry wins over a potentially stale alias stub — while the
		// advertised alias entry's cache_control is preserved.
		expect(result.tools).toEqual([
			expect.objectContaining({
				description: "Current",
				input_schema: { v: 2 },
				cache_control: { type: "ephemeral", ttl: "1h" },
			}),
		]);
	});

	it("prefers the renamed flat entry over a stale alias stub regardless of payload order", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				tools: [
					// Alias stub FIRST in the payload, with a stale schema.
					{
						name: "mcp__exa_mcp__web_search_exa",
						description: "Stale alias stub",
						input_schema: { v: 1 },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
					{ name: "web_search_exa", description: "Current", input_schema: { v: 2 } },
				],
				messages: [],
			},
			false,
		);

		expect(result.tools).toEqual([
			{
				name: "mcp__exa_mcp__web_search_exa",
				description: "Current",
				input_schema: { v: 2 },
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		]);
	});

	it("filters aliased flat tools when the MCP alias is not in the tool list", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				tools: [{ name: "web_search_exa", description: "Orphan", input_schema: {} }],
				messages: [],
			},
			false,
		);

		expect(result.tools).toEqual([]);
	});

	it("passes all tools through unchanged when filter is disabled", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				tools: [
					{ name: "web_search_exa", description: "Flat", input_schema: {} },
					{ name: "mcp__exa_mcp__web_search_exa", description: "Alias", input_schema: {} },
					{ name: "totally_unknown", description: "Custom ext", input_schema: {} },
				],
				messages: [],
			},
			true,
		);

		expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual([
			"web_search_exa",
			"mcp__exa_mcp__web_search_exa",
			"totally_unknown",
		]);
	});

	// ----------------------------------------------------------------
	// tool_choice remapping
	// ----------------------------------------------------------------

	it("remaps tool_choice from flat name to MCP alias", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				tool_choice: { type: "tool", name: "web_search_exa" },
				tools: [
					{ name: "web_search_exa", input_schema: {} },
					{ name: "mcp__exa_mcp__web_search_exa", input_schema: {} },
				],
				messages: [],
			},
			false,
		);

		expect(result.tool_choice).toEqual({ type: "tool", name: "mcp__exa_mcp__web_search_exa" });
	});

	it("clears tool_choice when the referenced tool is filtered out", () => {
		const result = _test.transformPayload(
			{
				tool_choice: { type: "tool", name: "unknown_tool" },
				tools: [{ name: "unknown_tool", input_schema: {} }],
				messages: [],
			},
			false,
		);

		expect(result.tool_choice).toBeUndefined();
	});

	it("leaves non-tool tool_choice types unchanged", () => {
		const surviving = new Map([["read", "Read"]]);
		expect(_test.remapToolChoice({ type: "auto" }, surviving)).toEqual({ type: "auto" });
		expect(_test.remapToolChoice({ type: "any" }, surviving)).toEqual({ type: "any" });
	});

	it("normalizes tool_choice casing to match advertised tool names", () => {
		const result = _test.transformPayload(
			{
				tool_choice: { type: "tool", name: "read" },
				tools: [{ name: "Read", description: "Read files", input_schema: {} }],
				messages: [],
			},
			false,
		);

		expect(result.tool_choice).toEqual({ type: "tool", name: "Read" });
	});

	// ----------------------------------------------------------------
	// Historical tool_use message rewriting
	// ----------------------------------------------------------------

	it("renames tool_use blocks in message history when MCP alias survives filtering", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Searching..." },
							{ type: "tool_use", id: "toolu_abc", name: "web_search_exa", input: { q: "test" } },
						],
					},
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: "done" }],
					},
				],
				tools: [
					{ name: "web_search_exa", input_schema: {} },
					{ name: "mcp__exa_mcp__web_search_exa", input_schema: {} },
				],
			},
			false,
		);

		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Searching..." },
					{ type: "tool_use", id: "toolu_abc", name: "mcp__exa_mcp__web_search_exa", input: { q: "test" } },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: "done" }],
			},
		]);
	});

	it("preserves tool_use names when no MCP alias survives filtering", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "toolu_1", name: "web_search_exa", input: {} }],
					},
				],
				tools: [{ name: "web_search_exa", input_schema: {} }],
			},
			false,
		);

		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_1", name: "web_search_exa", input: {} }],
			},
		]);
	});

	// ----------------------------------------------------------------
	// Full payload integration
	// ----------------------------------------------------------------

	it("applies all transforms together: system rewrite, tool filter, tool_choice, messages", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				model: "claude-opus-4-6",
				system: [
					{
						type: "text",
						text: "You are Claude Code.",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
					{
						type: "text",
						text: "Pi docs (ask about pi itself):",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
				messages: [{ role: "user", content: [{ type: "text", text: "Search for bugs" }] }],
				tools: [
					{ name: "Read", description: "Read files", input_schema: {} },
					{ type: "web_search", name: "web_search", search_context_size: "high" },
					{ name: "web_search_exa", description: "Exa", input_schema: {} },
					{ name: "mcp__exa_mcp__web_search_exa", description: "Alias", input_schema: {} },
					{ name: "mcp__custom__tool", description: "Custom", input_schema: {} },
					{ name: "unknown_flat", description: "Dropped", input_schema: {} },
				],
			},
			false,
		);

		expect(result.system).toEqual([
			{
				type: "text",
				text: "You are Claude Code.",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
			{
				type: "text",
				text: "Pi docs (ask about the cli itself):",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		]);

		expect((result.tools as { name?: string; type?: string }[]).map((t) => t.name ?? t.type)).toEqual([
			"Read",
			"web_search",
			"mcp__exa_mcp__web_search_exa",
			"mcp__custom__tool",
		]);

		// Must not inject metadata (that's Tier 2)
		expect("metadata" in result).toBe(false);
	});

	it("passes tools, tool_choice, and messages through unchanged with filter disabled", () => {
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		const result = _test.transformPayload(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "toolu_x", name: "web_search_exa", input: { q: "pi" } }],
					},
				],
				tool_choice: { type: "tool", name: "web_search_exa" },
				tools: [
					{ name: "web_search_exa", description: "Flat", input_schema: {} },
					{ name: "mcp__exa_mcp__web_search_exa", description: "Alias", input_schema: {} },
					{ name: "custom_ext_tool", description: "Custom", input_schema: {} },
				],
			},
			true,
		);

		expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual([
			"web_search_exa",
			"mcp__exa_mcp__web_search_exa",
			"custom_ext_tool",
		]);
		expect(result.tool_choice).toEqual({ type: "tool", name: "web_search_exa" });
		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_x", name: "web_search_exa", input: { q: "pi" } }],
			},
		]);
	});

	// ----------------------------------------------------------------
	// Alias derivation
	// ----------------------------------------------------------------

	describe("alias derivation", () => {
		it("derives server segment from a scoped npm package path", () => {
			expect(
				_test.deriveServerSegment({
					path: "/home/u/.pi/agent/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts",
					source: "t",
					scope: "user",
					origin: "package",
				} as never),
			).toBe("exa_mcp");
		});

		it("derives server segment from an unscoped npm package path", () => {
			expect(
				_test.deriveServerSegment({
					path: "/x/node_modules/pi-web-providers/dist/index.js",
					source: "t",
					scope: "user",
					origin: "package",
				} as never),
			).toBe("web_providers");
		});

		it("derives server segment from a monorepo package directory", () => {
			expect(
				_test.deriveServerSegment({
					path: "/home/u/.pi/agent/git/github.com/ben-vargas/pi-packages/packages/pi-firecrawl/extensions/index.ts",
					source: "t",
					scope: "user",
					origin: "package",
				} as never),
			).toBe("firecrawl");
		});

		it("derives server segment from a single-file extension stem", () => {
			expect(
				_test.deriveServerSegment({
					path: "/home/u/.pi/agent/extensions/my-tool.ts",
					source: "t",
					scope: "user",
					origin: "file",
				} as never),
			).toBe("my_tool");
		});

		it("uses 'pi' for synthetic builtin/sdk sources", () => {
			expect(
				_test.deriveServerSegment({
					path: "<builtin:ls>",
					source: "builtin",
					scope: "user",
					origin: "builtin",
				} as never),
			).toBe("pi");
			expect(_test.deriveServerSegment(undefined)).toBe("pi");
		});

		it("handles Windows-style backslash paths", () => {
			expect(
				_test.deriveServerSegment({
					path: "C:\\Users\\dev\\node_modules\\@benvargas\\pi-exa-mcp\\extensions\\index.ts",
					source: "t",
					scope: "user",
					origin: "package",
				} as never),
			).toBe("exa_mcp");
		});

		it("builds full alias names from server segment and sanitized tool name", () => {
			const tool = mockTool("web_search_exa", {
				path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts",
			});
			expect(_test.deriveAliasBase(tool as never)).toBe("mcp__exa_mcp__web_search_exa");
		});

		it("sanitizes hostile segments and falls back when empty", () => {
			expect(_test.sanitizeAliasSegment("Weird Name!!", "ext")).toBe("weird_name");
			expect(_test.sanitizeAliasSegment("---", "ext")).toBe("ext");
		});

		it("resolves collisions with deterministic numeric suffixes", () => {
			const taken = new Set(["mcp__ext__tool"]);
			expect(_test.reserveAliasName("mcp__ext__tool", taken)).toBe("mcp__ext__tool_2");
			taken.add("mcp__ext__tool_2");
			expect(_test.reserveAliasName("mcp__ext__tool", taken)).toBe("mcp__ext__tool_3");
		});

		it("keeps alias names within the 128-char limit even with suffixes", () => {
			const base = `mcp__server__${"x".repeat(140)}`;
			const taken = new Set<string>();
			const first = _test.reserveAliasName(base, taken);
			expect(first.length).toBe(128);
			taken.add(first.toLowerCase());
			const second = _test.reserveAliasName(base, taken);
			expect(second.length).toBeLessThanOrEqual(128);
			expect(second.endsWith("_2")).toBe(true);
		});
	});

	// ----------------------------------------------------------------
	// Dynamic alias registration (getAllTools-based)
	// ----------------------------------------------------------------

	describe("registerMcpAliases", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "pi-claude-code-use-"));
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("registers derived MCP aliases for non-core flat tools", () => {
			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				mockTool("read"),
				mockTool("web_search_exa", {
					path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts",
					description: "Search the web with Exa",
				}),
			]);

			registerAliasesIsolated(pi, tempDir);

			expect(pi.registerTool).toHaveBeenCalledTimes(1);
			expect(pi.registerTool).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "mcp__exa_mcp__web_search_exa",
					label: "MCP web_search_exa",
					description: "Search the web with Exa",
				}),
			);
			expect(_test.FLAT_TO_MCP.get("web_search_exa")).toBe("mcp__exa_mcp__web_search_exa");
			expect(_test.MCP_TO_FLAT.get("mcp__exa_mcp__web_search_exa")).toBe("web_search_exa");
			expect(_test.registeredMcpAliases.has("mcp__exa_mcp__web_search_exa")).toBe(true);
		});

		describe("alias result rendering", () => {
			// The renderer consults pi-tui's global terminal capability cache for
			// image support; restore it after every test. keyHint call/override
			// state is likewise reset so tests stay isolated.
			afterEach(() => {
				resetCapabilitiesCache();
				vi.mocked(keyHint).mockClear();
			});

			// Identity theme keeps assertions exact. keyHint() needs Pi's interactive
			// theme (uninitialized here), so the renderer's fallback hint path runs
			// and composes "… (ctrl+o to expand)" from this theme deterministically.
			const theme = { fg: (_color: string, text: string) => text } as never;
			const HINT = "… (ctrl+o to expand)";

			type ResultPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

			function aliasDefinition() {
				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([mockTool("mcp", { path: "/x/node_modules/pi-mcp-adapter/index.ts" })]);
				registerAliasesIsolated(pi, tempDir);
				return pi.registerTool.mock.calls[0]?.[0] as Parameters<ExtensionAPI["registerTool"]>[0];
			}

			/** Render an alias result and return trimmed lines (Text pads lines to the render width). */
			function renderLines(
				content: ResultPart[],
				opts: { expanded?: boolean; isPartial?: boolean; showImages?: boolean; width?: number } = {},
			): string[] {
				const definition = aliasDefinition();
				const component = definition.renderResult?.(
					{ content, details: {} } as never,
					{ expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false },
					theme,
					{ showImages: opts.showImages ?? true } as never,
				);
				expect(component).toBeDefined();
				return (component?.render(opts.width ?? 80) ?? []).map((line) => line.trimEnd());
			}

			const text = (value: string): ResultPart[] => [{ type: "text", text: value }];
			const png = (): ResultPart => ({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });

			it("renders short results exactly, without an expansion hint", () => {
				expect(renderLines(text("one\ntwo"))).toEqual(["one", "two"]);
				expect(renderLines(text("one\ntwo"), { expanded: true })).toEqual(["one", "two"]);
			});

			it("collapses long results to three lines with a keybinding-aware expansion hint", () => {
				const content = text("one\ntwo\nthree\nfour\nfive");
				expect(renderLines(content)).toEqual(["one", "two", "three", HINT]);
				expect(renderLines(content, { expanded: true })).toEqual(["one", "two", "three", "four", "five"]);
			});

			it("renders the user's configured app.tools.expand binding when keyHint resolves", () => {
				// Simulate an initialized TUI where the user rebound app.tools.expand
				// to ctrl+e: keyHint resolves the configured key, not the default.
				vi.mocked(keyHint).mockReturnValueOnce("ctrl+e to expand");
				const lines = renderLines(text("one\ntwo\nthree\nfour\nfive"));
				expect(keyHint).toHaveBeenCalledWith("app.tools.expand", "to expand");
				expect(lines).toEqual(["one", "two", "three", "… (ctrl+e to expand)"]);
				expect(lines[3]).not.toContain("ctrl+o");
			});

			it("falls back to keyText/default composition only after keyHint throws outside the TUI", () => {
				const lines = renderLines(text("one\ntwo\nthree\nfour\nfive"));
				// The configured-binding path is consulted first; the uninitialized
				// interactive theme makes the real keyHint throw, and the hint is then
				// composed from keyText (empty here) and the "ctrl+o" default.
				expect(keyHint).toHaveBeenCalledWith("app.tools.expand", "to expand");
				expect(vi.mocked(keyHint).mock.results[0]?.type).toBe("throw");
				expect(lines).toEqual(["one", "two", "three", HINT]);
			});

			it("counts wrapped visual lines against the collapse limit", () => {
				// 20 five-char words wrap to 4 visual lines at width 30 (5 words per line).
				const content = text("word ".repeat(20).trim());
				const expanded = renderLines(content, { expanded: true, width: 30 });
				expect(expanded).toHaveLength(4);
				const collapsed = renderLines(content, { width: 30 });
				expect(collapsed).toEqual([...expanded.slice(0, 3), HINT]);
			});

			it("truncates collapsed output beyond 2000 characters and expands to the full text", () => {
				const content = text("x".repeat(2500));
				// Wide enough that the truncated text fits on one visual line.
				expect(renderLines(content, { width: 4000 })).toEqual(["x".repeat(2000), HINT]);
				expect(renderLines(content, { expanded: true, width: 4000 })).toEqual(["x".repeat(2500)]);
				// Narrow terminals additionally collapse by visual lines.
				expect(renderLines(content, { width: 100 })).toHaveLength(4);
			});

			it("does not split surrogate pairs at the truncation boundary", () => {
				const { text: truncated, truncated: didTruncate } = _test.truncateCodePoints(`${"a".repeat(1999)}😀😀😀`, 2000);
				expect(didTruncate).toBe(true);
				// 2000 code points: 1999 ASCII chars plus one complete emoji (2 UTF-16 units).
				expect(truncated).toBe(`${"a".repeat(1999)}😀`);
				expect(renderLines(text(`${"a".repeat(1999)}😀😀😀`), { width: 4000 })).toEqual([
					`${"a".repeat(1999)}😀`,
					HINT,
				]);
			});

			it("strips ESC-form ANSI CSI/OSC sequences, C0 controls, and carriage returns", () => {
				expect(_test.sanitizeResultText("\u001b[31mred\u001b[0m \u001b]0;title\u0007mid\u0000dle\rend\ttail")).toBe(
					"red middleend\ttail",
				);
				// Lone surrogates are dropped; paired ones survive.
				expect(_test.sanitizeResultText("a\ud800b\ud83d\ude00")).toBe("ab\ud83d\ude00");
				// Rendered output is normalized before styling/truncation (tabs become spaces in the TUI).
				expect(renderLines(text("\u001b[31mred\u001b[0m line\r\nnext"))).toEqual(["red line", "next"]);
			});

			it("strips C1-form OSC sequences terminated by BEL or ST", () => {
				expect(_test.sanitizeResultText("before\u009d0;bel-title\u0007after")).toBe("beforeafter");
				expect(_test.sanitizeResultText("before\u009d0;st-title\u009cafter")).toBe("beforeafter");
				// C1 CSI remains supported, and the registered renderer uses the same hardened path.
				expect(_test.sanitizeResultText("\u009b31mred\u009b0m")).toBe("red");
				expect(renderLines(text("\u009d0;title\u009cvisible\u0085text"))).toEqual(["visibletext"]);
			});

			it("drops standalone C1 controls and malformed C1 introducers while preserving tab and LF", () => {
				const everyC1Control = String.fromCodePoint(...Array.from({ length: 0x20 }, (_, i) => 0x80 + i));
				expect(_test.sanitizeResultText(`left${everyC1Control}right`)).toBe("leftright");
				expect(_test.sanitizeResultText("a\u009dunterminated")).toBe("aunterminated");
				expect(_test.sanitizeResultText("a\u009b/unterminated")).toBe("a/unterminated");
				expect(_test.sanitizeResultText("tab\tline\nnext")).toBe("tab\tline\nnext");
			});

			it("leaves inline images to the tool row when the terminal shows them", () => {
				setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
				// Image-only inline result: no textual placeholder and no "(empty result)".
				expect(renderLines([png()])).toEqual([]);
				expect(renderLines([text("hello")[0] as ResultPart, png()])).toEqual(["hello"]);
			});

			it("renders an image fallback when images are hidden or unsupported", () => {
				setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
				expect(renderLines([png()], { showImages: false })).toEqual(["[Image: [image/png]]"]);
				expect(renderLines([text("hi")[0] as ResultPart, png()], { showImages: false })).toEqual([
					"hi",
					"[Image: [image/png]]",
				]);

				setCapabilities({ images: null, trueColor: false, hyperlinks: false });
				expect(renderLines([png()])).toEqual(["[Image: [image/png]]"]);
			});

			it("sanitizes hostile ESC sequences and controls in hidden-image MIME fallbacks", () => {
				setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
				const hostileMime = "image/\u001b[31mred\u001b[0m-\u001b]0;PWNED\u0007png\u0000\u0008\u000b\u001f\u007f\r";
				const output = renderLines([{ type: "image", data: "", mimeType: hostileMime }], {
					showImages: false,
				}).join("\n");

				expect(output).toBe("[Image: [image/red-png]]");
				expect(output).not.toContain("PWNED");
				expect(_test.sanitizeResultText(output)).toBe(output);
			});

			it("sanitizes hostile C1 sequences and controls in unsupported-image MIME fallbacks", () => {
				setCapabilities({ images: null, trueColor: false, hyperlinks: false });
				const hostileMime = "image/\u009b31mred\u009b0m-\u009d0;PWNED\u009cpng\u0080\u0085\u008f\u009f\u007f\r";
				const output = renderLines([{ type: "image", data: "", mimeType: hostileMime }]).join("\n");

				expect(output).toBe("[Image: [image/red-png]]");
				expect(output).not.toContain("PWNED");
				expect(_test.sanitizeResultText(output)).toBe(output);
			});

			it("streams partial results through the same compact renderer", () => {
				expect(renderLines(text("partial chunk"), { isPartial: true })).toEqual(["partial chunk"]);
				// An empty partial result is still streaming — render nothing, not "(empty result)".
				expect(renderLines([], { isPartial: true })).toEqual([]);
				expect(renderLines(text(""), { isPartial: true })).toEqual([]);
			});

			it("marks genuinely empty final results", () => {
				expect(renderLines([])).toEqual(["(empty result)"]);
				expect(renderLines(text(""))).toEqual(["(empty result)"]);
			});
		});

		it("does not alias core tools or mcp__-prefixed tools", () => {
			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([mockTool("read"), mockTool("Bash"), mockTool("mcp__real__server_tool")]);

			registerAliasesIsolated(pi, tempDir);

			expect(pi.registerTool).not.toHaveBeenCalled();
			expect(_test.FLAT_TO_MCP.size).toBe(0);
		});

		it("picks up tools registered by other extensions' lifecycle hooks on a later pass", () => {
			const pi = createMockPi();
			// First pass: companion extension has not registered its tools yet.
			pi.getAllTools.mockReturnValue([mockTool("read")]);
			registerAliasesIsolated(pi, tempDir);
			expect(pi.registerTool).not.toHaveBeenCalled();

			// Second pass (before_agent_start): hook-registered tool now present.
			pi.getAllTools.mockReturnValue([
				mockTool("read"),
				mockTool("web_search", { path: "/x/node_modules/pi-web-providers/dist/index.js" }),
			]);
			registerAliasesIsolated(pi, tempDir);

			expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp__web_providers__web_search" }));
			expect(_test.FLAT_TO_MCP.get("web_search")).toBe("mcp__web_providers__web_search");
		});

		it("marks freshly registered aliases as auto-activated (pi auto-activates new tools)", () => {
			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
			]);

			registerAliasesIsolated(pi, tempDir);

			// Pi's registerTool implicitly activates the new alias; provenance must
			// record it as auto-managed so a non-OAuth sync removes it.
			expect(_test.autoActivatedAliases.has("mcp__exa_mcp__web_search_exa")).toBe(true);

			pi.getAllTools.mockReturnValue([
				mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
				mockTool("mcp__exa_mcp__web_search_exa"),
			]);
			pi.getActiveTools.mockReturnValue(["read", "web_search_exa", "mcp__exa_mcp__web_search_exa"]);
			_test.syncAliasActivation(pi as unknown as ExtensionAPI, false);
			expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "web_search_exa"]);
		});

		it("re-registers an alias when the source tool's schema changes", () => {
			const pi = createMockPi();
			const path = "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts";
			const v1 = mockTool("web_search_exa", { path, description: "v1" });
			pi.getAllTools.mockReturnValue([v1]);
			registerAliasesIsolated(pi, tempDir);
			expect(pi.registerTool).toHaveBeenCalledTimes(1);

			// Same metadata: no re-registration.
			registerAliasesIsolated(pi, tempDir);
			expect(pi.registerTool).toHaveBeenCalledTimes(1);

			// Source extension re-registered the tool with new metadata.
			const v2 = mockTool("web_search_exa", { path, description: "v2" });
			pi.getAllTools.mockReturnValue([v2]);
			registerAliasesIsolated(pi, tempDir);
			expect(pi.registerTool).toHaveBeenCalledTimes(2);
			expect(pi.registerTool).toHaveBeenLastCalledWith(
				expect.objectContaining({ name: "mcp__exa_mcp__web_search_exa", description: "v2" }),
			);
		});

		it("copies parameters and promptGuidelines onto the alias by identity", () => {
			const pi = createMockPi();
			const parameters = { type: "object", properties: { q: { type: "string" } } };
			const promptGuidelines = ["Prefer batched queries"];
			pi.getAllTools.mockReturnValue([
				{
					...mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
					parameters: parameters as never,
					promptGuidelines,
				},
			]);

			registerAliasesIsolated(pi, tempDir);

			const def = pi.registerTool.mock.calls[0]?.[0] as { parameters: unknown; promptGuidelines?: unknown };
			expect(def.parameters).toBe(parameters);
			expect(def.promptGuidelines).toBe(promptGuidelines);
		});

		it("excludes case-insensitive duplicate flat tool names from aliasing entirely", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([
					mockTool("MyTool", { path: "/x/node_modules/pi-ext-a/index.js" }),
					mockTool("mytool", { path: "/y/node_modules/pi-ext-b/index.js" }),
				]);

				registerAliasesIsolated(pi, tempDir);

				// Aliasing either variant could route a call for one tool to the other
				// (all alias state is lowercase-keyed, pi execution lookup is exact),
				// so neither gets an alias.
				expect(pi.registerTool).not.toHaveBeenCalled();
				expect(_test.FLAT_TO_MCP.size).toBe(0);
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("case-insensitive duplicate"));
			} finally {
				warn.mockRestore();
			}
		});

		it("tracks a case-only alias rename as a new auto-activated exact name", () => {
			const pi = createMockPi();
			const path = "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts";
			const projectDir = join(tempDir, "project");
			const configPath = join(projectDir, ".pi", "extensions", "pi-claude-code-use.json");
			mkdirSync(dirname(configPath), { recursive: true });

			const tool = mockTool("web_search_exa", { path });
			pi.getAllTools.mockReturnValue([tool]);

			writeFileSync(configPath, JSON.stringify({ toolAliases: [["web_search_exa", "MCP__Exa__Search"]] }));
			registerAliasesIsolated(pi, tempDir);
			expect(_test.autoActivatedAliases.has("MCP__Exa__Search")).toBe(true);

			// Simulate the user having promoted the old casing, then changing the
			// config to a different casing. Pi keys tools by exact name, so the new
			// casing is a brand-new (auto-activated) tool name.
			_test.autoActivatedAliases.clear();
			writeFileSync(configPath, JSON.stringify({ toolAliases: [["web_search_exa", "mcp__exa__search"]] }));
			registerAliasesIsolated(pi, tempDir);

			expect(pi.registerTool).toHaveBeenCalledTimes(2);
			expect(pi.registerTool).toHaveBeenLastCalledWith(expect.objectContaining({ name: "mcp__exa__search" }));
			expect(_test.autoActivatedAliases.has("mcp__exa__search")).toBe(true);
		});

		it("does not flip a user-selected alias back to auto-managed on schema re-registration", () => {
			const pi = createMockPi();
			const path = "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts";
			pi.getAllTools.mockReturnValue([mockTool("web_search_exa", { path, description: "v1" })]);
			registerAliasesIsolated(pi, tempDir);
			expect(_test.autoActivatedAliases.has("mcp__exa_mcp__web_search_exa")).toBe(true);

			// Simulate promotion to user-selected (user kept the alias deliberately).
			_test.autoActivatedAliases.delete("mcp__exa_mcp__web_search_exa");

			// Source schema changes → alias re-registered, but provenance must not flip:
			// pi preserves activation for same-name re-registrations.
			pi.getAllTools.mockReturnValue([mockTool("web_search_exa", { path, description: "v2" })]);
			registerAliasesIsolated(pi, tempDir);
			expect(pi.registerTool).toHaveBeenCalledTimes(2);
			expect(_test.autoActivatedAliases.has("mcp__exa_mcp__web_search_exa")).toBe(false);
		});

		it("registers alias stubs whose execute throws instead of shadow-executing", async () => {
			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
			]);

			registerAliasesIsolated(pi, tempDir);

			const def = pi.registerTool.mock.calls[0]?.[0] as {
				execute: (...args: unknown[]) => Promise<unknown>;
			};
			await expect(def.execute()).rejects.toThrow(/routed it to "web_search_exa"/);
		});

		it("assigns deterministic suffixes when two tools derive the same alias", () => {
			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				// Distinct flat names that sanitize to the same alias segment:
				mockTool("my-search", { path: "/x/node_modules/pi-ext-a/index.js" }),
				mockTool("my_search", { path: "/y/node_modules/pi-ext-a/index.js" }),
			]);

			registerAliasesIsolated(pi, tempDir);

			const names = pi.registerTool.mock.calls.map((c) => (c[0] as { name: string }).name).sort();
			expect(names).toEqual(["mcp__ext_a__my_search", "mcp__ext_a__my_search_2"]);
			// Sorted by lowercased flat name: "my-search" < "my_search" — order is deterministic.
			expect(_test.FLAT_TO_MCP.get("my-search")).toBe("mcp__ext_a__my_search");
			expect(_test.FLAT_TO_MCP.get("my_search")).toBe("mcp__ext_a__my_search_2");
		});

		it("does not derive an alias name that collides with an existing tool", () => {
			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				mockTool("mcp__ext_a__search"),
				mockTool("search", { path: "/x/node_modules/pi-ext-a/index.js" }),
			]);

			registerAliasesIsolated(pi, tempDir);

			expect(pi.registerTool).toHaveBeenCalledTimes(1);
			expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp__ext_a__search_2" }));
		});

		it("keeps alias assignments stable across repeated passes", () => {
			const pi = createMockPi();
			const tools = [mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" })];
			pi.getAllTools.mockReturnValue(tools);

			registerAliasesIsolated(pi, tempDir);
			const firstAlias = _test.FLAT_TO_MCP.get("web_search_exa");

			// Second pass: the alias tool is now part of the registry.
			pi.getAllTools.mockReturnValue([...tools, mockTool(firstAlias as string)]);
			registerAliasesIsolated(pi, tempDir);

			expect(_test.FLAT_TO_MCP.get("web_search_exa")).toBe(firstAlias);
			// Registered exactly once.
			expect(pi.registerTool).toHaveBeenCalledTimes(1);
		});

		it("skips auto-derivation when PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS=1", () => {
			vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS", "1");
			try {
				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([
					mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
				]);

				registerAliasesIsolated(pi, tempDir);

				expect(pi.registerTool).not.toHaveBeenCalled();
				expect(_test.FLAT_TO_MCP.size).toBe(0);
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("still applies user-configured aliases when auto-derivation is disabled", () => {
			vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS", "1");
			try {
				const projectDir = join(tempDir, "project");
				const configPath = join(projectDir, ".pi", "extensions", "pi-claude-code-use.json");
				mkdirSync(dirname(configPath), { recursive: true });
				writeFileSync(configPath, JSON.stringify({ toolAliases: [["web_search_exa", "mcp__exa__web_search"]] }));

				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([
					mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
				]);

				registerAliasesIsolated(pi, tempDir);

				expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp__exa__web_search" }));
				expect(_test.FLAT_TO_MCP.get("web_search_exa")).toBe("mcp__exa__web_search");
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});

	// ----------------------------------------------------------------
	// Alias activation tracking
	// ----------------------------------------------------------------

	it("activates MCP aliases for active flat source tools, then removes them on disable", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa_mcp__web_search_exa")]);
		pi.getActiveTools.mockReturnValue(["read", "web_search_exa"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "web_search_exa", "mcp__exa_mcp__web_search_exa"]);

		// Now disable: should remove the alias
		pi.setActiveTools.mockClear();
		pi.getActiveTools.mockReturnValue(["read", "web_search_exa", "mcp__exa_mcp__web_search_exa"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, false);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "web_search_exa"]);
	});

	it("does not remove non-extension MCP tools when disabling aliases", () => {
		const pi = createMockPi();
		// This MCP tool was NOT registered by our extension (registeredMcpAliases is empty)
		pi.getAllTools.mockReturnValue([mockTool("mcp__exa__web_search")]);
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, false);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("preserves user-selected aliases when disabling auto-activation", () => {
		const pi = createMockPi();
		_test.registeredMcpAliases.add("mcp__exa__web_search");
		// Only mcp__firecrawl__scrape was auto-activated; mcp__exa__web_search was user-selected
		_test.autoActivatedAliases.add("mcp__firecrawl__scrape");
		_test.registeredMcpAliases.add("mcp__firecrawl__scrape");

		pi.getAllTools.mockReturnValue([mockTool("mcp__exa__web_search"), mockTool("mcp__firecrawl__scrape")]);
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search", "mcp__firecrawl__scrape"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, false);
		// Should remove auto-activated mcp__firecrawl__scrape but keep user-selected mcp__exa__web_search
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "mcp__exa__web_search"]);
	});

	it("prunes auto-activated aliases when their flat counterpart is no longer active", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
		_test.autoActivatedAliases.add("mcp__exa_mcp__web_search_exa");
		_test.setLastManagedToolList(["read", "mcp__exa_mcp__web_search_exa"]);

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa_mcp__web_search_exa")]);
		// web_search_exa is NOT active, only the alias is (stale state)
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa_mcp__web_search_exa"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
	});

	it("promotes kept aliases for mixed-case flat tools (case-insensitive baseline comparison)", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["MyTool", "mcp__x__mytool"]]);
		_test.registeredMcpAliases.add("mcp__x__mytool");
		_test.autoActivatedAliases.add("mcp__x__mytool");
		_test.setLastManagedToolList(["read", "MyTool", "mcp__x__mytool"]);

		pi.getAllTools.mockReturnValue([mockTool("MyTool"), mockTool("mcp__x__mytool")]);
		// User removed the exact-cased flat tool but kept the alias.
		pi.getActiveTools.mockReturnValue(["read", "mcp__x__mytool"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(_test.autoActivatedAliases.has("mcp__x__mytool")).toBe(false);
	});

	it("honors a kept alias when switching to non-OAuth before another enabled sync", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
		_test.autoActivatedAliases.add("mcp__exa_mcp__web_search_exa");
		_test.setLastManagedToolList(["read", "web_search_exa", "mcp__exa_mcp__web_search_exa"]);

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa_mcp__web_search_exa")]);
		// User removed the flat tool, kept the alias, then switched models: the
		// next sync is the DISABLE branch, which must still honor the choice.
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa_mcp__web_search_exa"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, false);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("records the managed baseline even when the first sync is a no-op, enabling later promotion", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
		// Pi already auto-activated the fresh alias, and registration marked it auto-managed.
		_test.autoActivatedAliases.add("mcp__exa_mcp__web_search_exa");

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa_mcp__web_search_exa")]);
		pi.getActiveTools.mockReturnValue(["read", "web_search_exa", "mcp__exa_mcp__web_search_exa"]);

		// First sync: everything already in the desired state → no setActiveTools
		// call, but the baseline must still be recorded.
		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(_test.getLastManagedToolList()).toEqual(["read", "web_search_exa", "mcp__exa_mcp__web_search_exa"]);

		// User removes the flat tool via the picker but keeps the alias: promotion
		// must recognize the deliberate choice and preserve the alias.
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa_mcp__web_search_exa"]);
		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(_test.autoActivatedAliases.has("mcp__exa_mcp__web_search_exa")).toBe(false);
	});

	it("preserves aliases the user explicitly enabled via the tool picker", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
		// Alias is NOT in autoActivatedAliases → user added it manually

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa_mcp__web_search_exa")]);
		// web_search_exa is not active, but user manually enabled the MCP alias
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa_mcp__web_search_exa"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		// User-selected alias is preserved even without flat counterpart active
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("promotes auto-activated alias to user-selected when user removes flat but keeps alias", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
		_test.autoActivatedAliases.add("mcp__exa_mcp__web_search_exa");
		// Last sync had both flat + alias active
		_test.setLastManagedToolList(["read", "web_search_exa", "mcp__exa_mcp__web_search_exa"]);

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa_mcp__web_search_exa")]);
		// User removed web_search_exa (was in last managed) but kept the MCP alias
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa_mcp__web_search_exa"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		// Alias promoted to user-selected → preserved even though flat is inactive
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("prunes auto-activated aliases when flat was never managed (no promotion)", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
		_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
		_test.autoActivatedAliases.add("mcp__exa_mcp__web_search_exa");
		// Last sync did NOT include web_search_exa → flat was never managed
		_test.setLastManagedToolList(["read", "mcp__exa_mcp__web_search_exa"]);

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa_mcp__web_search_exa")]);
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa_mcp__web_search_exa"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		// Flat was never in managed list → no promotion, alias is pruned
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
	});

	it("does not auto-manage MCP aliases that were not registered by this extension", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([], [["web_search_exa", "mcp__exa__web_search"]]);
		// mcp__exa__web_search exists in allTools and activeTools, but is NOT in registeredMcpAliases
		// (simulates a third-party extension providing this MCP tool directly)
		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa__web_search")]);
		pi.getActiveTools.mockReturnValue(["read", "web_search_exa", "mcp__exa__web_search"]);

		// Enable aliases: should NOT add mcp__exa__web_search to desiredAliases since it's not in registeredMcpAliases
		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);

		// Disable aliases: the third-party alias must remain untouched
		pi.setActiveTools.mockClear();
		pi.getActiveTools.mockReturnValue(["read", "web_search_exa", "mcp__exa__web_search"]);
		_test.syncAliasActivation(pi as unknown as ExtensionAPI, false);

		// mcp__exa__web_search was never auto-activated by us, so it must NOT be removed
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("recognizes mixed-case mcp aliases from user config (case-insensitive registeredMcpAliases lookups)", () => {
		const pi = createMockPi();
		// refreshAliasMap stores the mcp value RAW (mixed-case), simulating a user
		// who put ["my_tool", "MCP__Foo__Bar"] in their pi-claude-code-use.json.
		_test.refreshAliasMap([["my_tool", "MCP__Foo__Bar"]]);
		// registerMcpAliases normalizes via lower(mcpName) before adding; mirror that here.
		_test.registeredMcpAliases.add("mcp__foo__bar");
		pi.getAllTools.mockReturnValue([mockTool("my_tool"), mockTool("MCP__Foo__Bar")]);
		pi.getActiveTools.mockReturnValue(["read", "my_tool"]);

		// Enable must recognize the registered alias despite mixed case and append
		// it to active tools.
		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "my_tool", "MCP__Foo__Bar"]);

		// Disable: removes the auto-activated mixed-case alias via the
		// autoActivatedAliases set populated during the enable pass above.
		// This branch locks in the auto-activation lookup.
		pi.setActiveTools.mockClear();
		pi.getActiveTools.mockReturnValue(["read", "my_tool", "MCP__Foo__Bar"]);
		_test.syncAliasActivation(pi as unknown as ExtensionAPI, false);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "my_tool"]);
	});

	it("preserves user-selected mixed-case mcp aliases on sync", () => {
		const pi = createMockPi();
		_test.refreshAliasMap([["my_tool", "MCP__Foo__Bar"]]);
		// registerMcpAliases normalizes via lower(mcpName) before adding; mirror that here.
		_test.registeredMcpAliases.add("mcp__foo__bar");
		pi.getAllTools.mockReturnValue([mockTool("my_tool"), mockTool("MCP__Foo__Bar")]);
		// User manually selected the mixed-case alias via the tool picker.
		// Flat counterpart is NOT active, so this exercises the preserve
		// user-selected path instead of auto-activation.
		pi.getActiveTools.mockReturnValue(["read", "MCP__Foo__Bar"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);

		// With lower(), the alias is recognized as registered → preserved
		// → next === activeNames → setActiveTools is NOT called.
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	// ----------------------------------------------------------------
	// before_provider_request handler (end-to-end)
	// ----------------------------------------------------------------

	async function getProviderRequestHandler(pi: ReturnType<typeof createMockPi>) {
		await piClaudeCodeUse(pi as unknown as ExtensionAPI);
		const hookCall = pi.on.mock.calls.find((c: unknown[]) => c[0] === "before_provider_request");
		const handler = hookCall?.[1] as (event: { payload: unknown }, ctx: Record<string, unknown>) => unknown;
		// The handler refreshes aliases from config; isolate from any real user config.
		const isolatedDir = mkdtempSync(join(tmpdir(), "pi-claude-code-use-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(isolatedDir, "agent"));
		return (event: { payload: unknown }, ctx: Record<string, unknown>) =>
			handler(event, { cwd: join(isolatedDir, "project"), ...ctx });
	}

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("transforms payload when model is anthropic OAuth", async () => {
		const pi = createMockPi();
		const handler = await getProviderRequestHandler(pi);

		const ctx = {
			model: { provider: "anthropic", id: "claude-opus-4-6" },
			modelRegistry: { isUsingOAuth: () => true },
		};

		const result = await handler(
			{
				payload: {
					system: "ask about pi itself",
					tools: [
						{ name: "Read", description: "Read", input_schema: {} },
						{ name: "unknown_flat", description: "Drop", input_schema: {} },
					],
					messages: [{ role: "user", content: "hi" }],
				},
			},
			ctx,
		);

		expect(result).toBeDefined();
		const p = result as Record<string, unknown>;
		expect(p.system).toBe("ask about the cli itself");
		expect((p.tools as { name: string }[]).map((t) => t.name)).toEqual(["Read"]);
	});

	it("aliases late-registered flat tools in-payload on the first turn", async () => {
		const pi = createMockPi();
		const handler = await getProviderRequestHandler(pi);

		// Simulate a companion extension whose before_agent_start ran AFTER ours
		// and registered web_search: it is active (in the payload) but no alias
		// pass has seen it yet.
		pi.getAllTools.mockReturnValue([
			mockTool("read"),
			mockTool("web_search", { path: "/x/node_modules/pi-web-providers/dist/index.js" }),
		]);

		const ctx = {
			model: { provider: "anthropic", id: "claude-opus-4-6" },
			modelRegistry: { isUsingOAuth: () => true },
		};

		const result = (await handler(
			{
				payload: {
					tools: [
						{ name: "Read", description: "Read", input_schema: {} },
						{ name: "web_search", description: "Managed web search", input_schema: {} },
					],
					messages: [],
				},
			},
			ctx,
		)) as Record<string, unknown>;

		// The alias gets registered during the request hook...
		expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp__web_providers__web_search" }));
		// ...and the flat tool is renamed in-payload even though the alias was not advertised.
		expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual(["Read", "mcp__web_providers__web_search"]);
	});

	it("returns undefined for non-anthropic models", async () => {
		const pi = createMockPi();
		const handler = await getProviderRequestHandler(pi);

		const ctx = {
			model: { provider: "openai", id: "gpt-5.4" },
			modelRegistry: { isUsingOAuth: () => false },
		};

		const result = handler(
			{
				payload: {
					system: "ask about pi itself",
					tools: [{ name: "unknown_flat", description: "Keep", input_schema: {} }],
					messages: [],
				},
			},
			ctx,
		);

		expect(result).toBeUndefined();
	});

	it("returns undefined for anthropic non-OAuth models", async () => {
		const pi = createMockPi();
		const handler = await getProviderRequestHandler(pi);

		const ctx = {
			model: { provider: "anthropic", id: "claude-opus-4-6" },
			modelRegistry: { isUsingOAuth: () => false },
		};

		const result = handler({ payload: { system: "pi itself", tools: [], messages: [] } }, ctx);

		expect(result).toBeUndefined();
	});

	// ----------------------------------------------------------------
	// User-defined tool aliases (pi-claude-code-use.json)
	// ----------------------------------------------------------------

	describe("user-defined tool aliases", () => {
		let testDir: string;
		let agentDir: string;
		let projectDir: string;
		let globalConfigPath: string;
		let projectConfigPath: string;

		beforeEach(() => {
			testDir = mkdtempSync(join(tmpdir(), "pi-claude-code-use-"));
			agentDir = join(testDir, "agent");
			projectDir = join(testDir, "project");
			globalConfigPath = join(agentDir, "extensions", "pi-claude-code-use.json");
			projectConfigPath = join(projectDir, ".pi", "extensions", "pi-claude-code-use.json");
			mkdirSync(dirname(globalConfigPath), { recursive: true });
			mkdirSync(dirname(projectConfigPath), { recursive: true });
		});

		afterEach(() => {
			if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		});

		it("extractToolAliasPairs keeps string pairs and drops malformed entries", () => {
			const pairs = _test.extractToolAliasPairs({
				toolAliases: [["subagent", "mcp__subagent__run"], ["only-one"], "not-a-pair", [123, "mcp__bad__num"]],
			});
			expect(pairs).toEqual([["subagent", "mcp__subagent__run"]]);
		});

		const load = () => _test.loadToolAliases(projectDir, agentDir);

		it("loadToolAliases: project file replaces global file", () => {
			writeFileSync(
				globalConfigPath,
				JSON.stringify({
					toolAliases: [
						["subagent", "mcp__subagent__global"],
						["only_global", "mcp__g__one"],
					],
				}),
			);
			writeFileSync(
				projectConfigPath,
				JSON.stringify({
					toolAliases: [
						["subagent", "mcp__subagent__project"],
						["only_project", "mcp__p__one"],
					],
				}),
			);

			const pairs = load();
			expect(pairs).toEqual([
				["subagent", "mcp__subagent__project"],
				["only_project", "mcp__p__one"],
			]);
		});

		it("loadToolAliases falls back to global when project file is absent", () => {
			writeFileSync(globalConfigPath, JSON.stringify({ toolAliases: [["only_global", "mcp__g__one"]] }));
			expect(load()).toEqual([["only_global", "mcp__g__one"]]);
		});

		it("loadToolAliases: explicit empty project array disables inherited globals", () => {
			writeFileSync(globalConfigPath, JSON.stringify({ toolAliases: [["only_global", "mcp__g__one"]] }));
			writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [] }));
			expect(load()).toEqual([]);
		});

		it("user overrides win over derived aliases", () => {
			writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["web_search_exa", "mcp__exa__web_search"]] }));

			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
			]);

			_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

			expect(pi.registerTool).toHaveBeenCalledTimes(1);
			expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp__exa__web_search" }));
			expect(_test.FLAT_TO_MCP.get("web_search_exa")).toBe("mcp__exa__web_search");
		});

		it("ignores user aliases that are not mcp__-prefixed and keeps the derived alias", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["subagent", "not_an_mcp_name"]] }));

				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([mockTool("subagent", { path: "/x/node_modules/pi-sub/index.js" })]);

				_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

				expect(pi.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "not_an_mcp_name" }));
				expect(warn).toHaveBeenCalledWith(expect.stringContaining('alias must start with "mcp__"'));
				// The invalid entry must not poison the alias maps: the derived alias wins.
				expect(_test.FLAT_TO_MCP.get("subagent")).toBe("mcp__sub__subagent");
				expect(_test.MCP_TO_FLAT.has("not_an_mcp_name")).toBe(false);
			} finally {
				warn.mockRestore();
			}
		});

		it("rejects user aliases that collide with another extension's MCP tool", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["subagent", "mcp__real__tool"]] }));

				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([
					mockTool("subagent", { path: "/x/node_modules/pi-sub/index.js" }),
					mockTool("mcp__real__tool"),
				]);

				_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

				expect(warn).toHaveBeenCalledWith(expect.stringContaining("already taken by another extension's tool"));
				// The foreign tool must not be routed to; derivation applies instead.
				expect(_test.FLAT_TO_MCP.get("subagent")).toBe("mcp__sub__subagent");
				expect(_test.MCP_TO_FLAT.has("mcp__real__tool")).toBe(false);
			} finally {
				warn.mockRestore();
			}
		});

		it("rejects overrides whose flat tool has a case-insensitive duplicate", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["mytool", "mcp__x__mytool"]] }));

				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([
					mockTool("MyTool", { path: "/x/node_modules/pi-ext-a/index.js" }),
					mockTool("mytool", { path: "/y/node_modules/pi-ext-b/index.js" }),
				]);

				_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

				expect(warn).toHaveBeenCalledWith(expect.stringContaining("case-insensitive duplicate in the registry"));
				expect(pi.registerTool).not.toHaveBeenCalled();
				expect(_test.FLAT_TO_MCP.size).toBe(0);
				expect(_test.MCP_TO_FLAT.size).toBe(0);
			} finally {
				warn.mockRestore();
			}
		});

		it("rejects duplicate override targets (first wins)", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				writeFileSync(
					projectConfigPath,
					JSON.stringify({
						toolAliases: [
							["tool_a", "mcp__shared__name"],
							["tool_b", "mcp__shared__name"],
						],
					}),
				);

				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([
					mockTool("tool_a", { path: "/x/node_modules/pi-a/index.js" }),
					mockTool("tool_b", { path: "/x/node_modules/pi-b/index.js" }),
				]);

				_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

				expect(warn).toHaveBeenCalledWith(expect.stringContaining("already used by another toolAliases entry"));
				expect(_test.FLAT_TO_MCP.get("tool_a")).toBe("mcp__shared__name");
				expect(_test.MCP_TO_FLAT.get("mcp__shared__name")).toBe("tool_a");
				// tool_b falls back to derivation.
				expect(_test.FLAT_TO_MCP.get("tool_b")).toBe("mcp__b__tool_b");
			} finally {
				warn.mockRestore();
			}
		});

		it("rejects overrides with surrounding whitespace or over-length names", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				writeFileSync(
					projectConfigPath,
					JSON.stringify({
						toolAliases: [
							["tool_a", " mcp__padded__name"],
							["tool_b", `mcp__long__${"x".repeat(130)}`],
						],
					}),
				);

				const pi = createMockPi();
				pi.getAllTools.mockReturnValue([]);

				_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

				expect(warn).toHaveBeenCalledWith(expect.stringContaining("surrounding whitespace"));
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeds 128 characters"));
				expect(_test.FLAT_TO_MCP.size).toBe(0);
			} finally {
				warn.mockRestore();
			}
		});

		it("reverts to the derived alias when an override is removed (auto-aliasing enabled)", () => {
			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
			]);

			writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["web_search_exa", "mcp__exa__web_search"]] }));
			_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });
			expect(_test.FLAT_TO_MCP.get("web_search_exa")).toBe("mcp__exa__web_search");

			// Remove the override: automatic derivation must take over again.
			writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [] }));
			_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });
			expect(_test.FLAT_TO_MCP.get("web_search_exa")).toBe("mcp__exa_mcp__web_search_exa");

			// The stale override alias keeps a reverse route for unaliasing.
			const msg = {
				role: "assistant",
				content: [{ type: "toolCall", id: "s", name: "mcp__exa__web_search", arguments: {} }],
			};
			const out = _test.unaliasToolCalls(msg) as typeof msg | undefined;
			expect(out).toBeDefined();
			expect((out?.content[0] as { name: string } | undefined)?.name).toBe("web_search_exa");
		});

		it("keeps user alias mappings for flat tools that are not in the registry", () => {
			writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["subagent", "mcp__subagent__run"]] }));

			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([]);

			_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

			// Nothing to register (no schema available) but the payload mapping applies.
			expect(pi.registerTool).not.toHaveBeenCalled();
			expect(_test.FLAT_TO_MCP.get("subagent")).toBe("mcp__subagent__run");
		});

		it("removes stale user aliases when project config changes", () => {
			vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS", "1");
			try {
				const pi = createMockPi();

				writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["subagent", "mcp__subagent__run"]] }));
				_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

				const withAlias = _test.transformPayload(
					{
						tools: [{ name: "subagent" }, { name: "mcp__subagent__run" }],
						tool_choice: { type: "tool", name: "subagent" },
						messages: [{ role: "assistant", content: [{ type: "tool_use", name: "subagent" }] }],
					},
					false,
				);
				expect(withAlias.tool_choice).toEqual({ type: "tool", name: "mcp__subagent__run" });
				expect((withAlias.messages as Array<{ content: Array<{ name: string }> }>)[0]?.content[0]?.name).toBe(
					"mcp__subagent__run",
				);

				writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [] }));
				_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });

				const withoutAlias = _test.transformPayload(
					{
						tools: [{ name: "subagent" }, { name: "mcp__subagent__run" }],
						tool_choice: { type: "tool", name: "subagent" },
						messages: [{ role: "assistant", content: [{ type: "tool_use", name: "subagent" }] }],
					},
					false,
				);
				expect(withoutAlias.tool_choice).toBeUndefined();
				expect((withoutAlias.messages as Array<{ content: Array<{ name: string }> }>)[0]?.content[0]?.name).toBe(
					"subagent",
				);

				_test.registeredMcpAliases.add("mcp__subagent__run");
				pi.getActiveTools.mockReturnValue(["subagent"]);
				pi.getAllTools.mockReturnValue([mockTool("subagent"), mockTool("mcp__subagent__run")]);
				_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
				expect(pi.setActiveTools).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("registers a schema-backed alias for a user-configured flat tool", () => {
			writeFileSync(projectConfigPath, JSON.stringify({ toolAliases: [["subagent", "mcp__subagent__run"]] }));

			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				mockTool("subagent", { path: "/x/my-subagent-ext/index.js", description: "User-configured subagent tool" }),
			]);

			try {
				_test.registerMcpAliases(pi as unknown as ExtensionAPI, { cwd: projectDir, agentDir });
				expect(pi.registerTool).toHaveBeenCalledWith(
					expect.objectContaining({ name: "mcp__subagent__run", description: "User-configured subagent tool" }),
				);
				expect(_test.FLAT_TO_MCP.get("subagent")).toBe("mcp__subagent__run");
			} finally {
				_test.FLAT_TO_MCP.delete("subagent");
			}
		});
	});

	describe("unaliasToolCalls (message_end intercept)", () => {
		it("rewrites a toolCall block's MCP-aliased name back to its flat counterpart", () => {
			_test.refreshAliasMap([["run_chain", "mcp__chain__run_chain"]]);
			_test.registeredMcpAliases.add("mcp__chain__run_chain");

			const msg = {
				role: "assistant",
				content: [
					{ type: "text", text: "running the chain" },
					{ type: "toolCall", id: "call_1", name: "mcp__chain__run_chain", arguments: { task: "ping" } },
				],
			};

			const out = _test.unaliasToolCalls(msg) as typeof msg | undefined;
			expect(out).toBeDefined();
			expect(out?.content[1]).toEqual({
				type: "toolCall",
				id: "call_1",
				name: "run_chain",
				arguments: { task: "ping" },
			});
			// Original message must not be mutated.
			expect((msg.content[1] as { name: string }).name).toBe("mcp__chain__run_chain");
		});

		it("returns undefined when no toolCall name needs rewriting", () => {
			_test.refreshAliasMap([["run_chain", "mcp__chain__run_chain"]]);

			const msg = {
				role: "assistant",
				content: [
					{ type: "text", text: "just text" },
					{ type: "toolCall", id: "call_1", name: "run_chain", arguments: {} },
				],
			};

			expect(_test.unaliasToolCalls(msg)).toBeUndefined();
		});

		it("ignores non-assistant messages", () => {
			_test.refreshAliasMap([["run_chain", "mcp__chain__run_chain"]]);
			expect(
				_test.unaliasToolCalls({
					role: "user",
					content: [{ type: "toolCall", id: "x", name: "mcp__chain__run_chain", arguments: {} }],
				}),
			).toBeUndefined();
		});

		it("rewrites multiple toolCall blocks in one message", () => {
			_test.refreshAliasMap([
				["run_chain", "mcp__chain__run_chain"],
				["query_experts", "mcp__pipi__query_experts"],
			]);
			_test.registeredMcpAliases.add("mcp__chain__run_chain");
			_test.registeredMcpAliases.add("mcp__pipi__query_experts");

			const msg = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "a", name: "mcp__chain__run_chain", arguments: {} },
					{ type: "toolCall", id: "b", name: "mcp__pipi__query_experts", arguments: {} },
					{ type: "toolCall", id: "c", name: "some_other_tool", arguments: {} },
				],
			};

			const out = _test.unaliasToolCalls(msg) as typeof msg;
			expect((out.content[0] as { name: string }).name).toBe("run_chain");
			expect((out.content[1] as { name: string }).name).toBe("query_experts");
			expect((out.content[2] as { name: string }).name).toBe("some_other_tool");
		});

		it("is wired up as a message_end handler", async () => {
			_test.refreshAliasMap([["run_chain", "mcp__chain__run_chain"]]);
			_test.registeredMcpAliases.add("mcp__chain__run_chain");

			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([mockTool("run_chain")]);
			await piClaudeCodeUse(pi as unknown as ExtensionAPI);

			const handler = getRegisteredHandler(pi, "message_end");
			expect(handler).toBeDefined();

			const event = {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "mcp__chain__run_chain", arguments: { task: "ping" } }],
				},
			};

			const result = (await handler(event, { cwd: "/tmp" })) as { message: { content: Array<{ name?: string }> } };
			expect(result).toBeDefined();
			expect(result.message.content[0].name).toBe("run_chain");
		});

		it("rewrites derived alias toolCalls back to the flat source name", () => {
			const pi = createMockPi();
			const tempDir = mkdtempSync(join(tmpdir(), "pi-claude-code-use-"));
			try {
				pi.getAllTools.mockReturnValue([
					mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
				]);
				registerAliasesIsolated(pi, tempDir);

				const msg = {
					role: "assistant",
					content: [{ type: "toolCall", id: "y", name: "mcp__exa_mcp__web_search_exa", arguments: {} }],
				};

				const out = _test.unaliasToolCalls(msg) as typeof msg | undefined;
				expect(out).toBeDefined();
				expect((out?.content[0] as { name: string } | undefined)?.name).toBe("web_search_exa");
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("leaves foreign mcp__ toolCalls untouched when not registered by this extension", () => {
			_test.refreshAliasMap([["web_search_exa", "mcp__exa__web_search"]]);
			// Mapping exists but the alias was NOT registered by this extension.

			const msg = {
				role: "assistant",
				content: [{ type: "toolCall", id: "x", name: "mcp__exa__web_search", arguments: {} }],
			};

			expect(_test.unaliasToolCalls(msg)).toBeUndefined();
		});

		it("in a mixed message, only registered aliases are rewritten; foreign mcp__ names are preserved", () => {
			_test.refreshAliasMap([
				["run_chain", "mcp__chain__run_chain"],
				["web_search_exa", "mcp__exa__web_search"],
			]);
			// Register only the first alias; the exa alias is NOT registered.
			_test.registeredMcpAliases.add("mcp__chain__run_chain");

			const msg = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "a", name: "mcp__chain__run_chain", arguments: {} },
					{ type: "toolCall", id: "b", name: "mcp__exa__web_search", arguments: {} },
				],
			};

			const out = _test.unaliasToolCalls(msg) as typeof msg | undefined;
			expect(out).toBeDefined();
			expect((out?.content[0] as { name: string } | undefined)?.name).toBe("run_chain");
			expect((out?.content[1] as { name: string } | undefined)?.name).toBe("mcp__exa__web_search");
		});

		it("rewrites mixed-case mcp__ toolCall names (case-insensitive lookup)", () => {
			_test.refreshAliasMap([["run_chain", "mcp__chain__run_chain"]]);
			_test.registeredMcpAliases.clear();
			_test.registeredMcpAliases.add("mcp__chain__run_chain");

			const msg = {
				role: "assistant",
				content: [{ type: "toolCall", id: "z", name: "MCP__Chain__Run_Chain", arguments: {} }],
			};

			const out = _test.unaliasToolCalls(msg) as typeof msg | undefined;
			expect(out).toBeDefined();
			expect((out?.content[0] as { name: string } | undefined)?.name).toBe("run_chain");
		});
	});

	// ----------------------------------------------------------------
	// Displayed prose un-cloaking (markdown transformer)
	// ----------------------------------------------------------------

	describe("unaliasDisplayedProse (markdown transformer)", () => {
		function ctx(overrides: Partial<MarkdownTransformContext> = {}): MarkdownTransformContext {
			return { messageType: "assistant", isStreaming: false, availableWidth: 80, ...overrides };
		}

		function aliasExa() {
			_test.refreshAliasMap([], [["web_search_exa", "mcp__exa_mcp__web_search_exa"]]);
			_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
			_test.registeredAliasRoutes.set("mcp__exa_mcp__web_search_exa", "web_search_exa");
		}

		it("registers unaliasDisplayedProse as the markdown transformer at factory load", async () => {
			const pi = createMockPi();
			await piClaudeCodeUse(pi as unknown as ExtensionAPI);

			expect(pi.registerMarkdownTransformer).toHaveBeenCalledTimes(1);
			expect(pi.registerMarkdownTransformer).toHaveBeenCalledWith(_test.unaliasDisplayedProse);

			// Drive the REGISTERED function (not just the export) with realistic input.
			aliasExa();
			const transformer = pi.registerMarkdownTransformer.mock.calls[0]?.[0] as typeof _test.unaliasDisplayedProse;
			expect(transformer("I'll call `mcp__exa_mcp__web_search_exa` next.", ctx())).toBe(
				"I'll call `web_search_exa` next.",
			);
		});

		it("loads on a pi without registerMarkdownTransformer (peer floor 0.77)", async () => {
			const { registerMarkdownTransformer: _omit, ...olderPi } = createMockPi();
			await expect(piClaudeCodeUse(olderPi as unknown as ExtensionAPI)).resolves.toBeUndefined();
		});

		it("rewrites registered aliases in assistant prose, including repeats and multiple aliases", () => {
			_test.refreshAliasMap(
				[],
				[
					["web_search_exa", "mcp__exa_mcp__web_search_exa"],
					["firecrawl_scrape", "mcp__firecrawl__firecrawl_scrape"],
				],
			);
			_test.registeredMcpAliases.add("mcp__exa_mcp__web_search_exa");
			_test.registeredMcpAliases.add("mcp__firecrawl__firecrawl_scrape");

			const input =
				"I'll use mcp__exa_mcp__web_search_exa to search, then `mcp__firecrawl__firecrawl_scrape` on each hit.\n" +
				"If mcp__exa_mcp__web_search_exa fails, I'll stop.";
			expect(_test.unaliasDisplayedProse(input, ctx())).toBe(
				"I'll use web_search_exa to search, then `firecrawl_scrape` on each hit.\nIf web_search_exa fails, I'll stop.",
			);
		});

		it("rewrites aliases registered from the live registry (end-to-end derivation)", () => {
			const pi = createMockPi();
			const tempDir = mkdtempSync(join(tmpdir(), "pi-claude-code-use-"));
			try {
				pi.getAllTools.mockReturnValue([
					mockTool("web_search_exa", { path: "/x/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts" }),
				]);
				registerAliasesIsolated(pi, tempDir);

				expect(_test.unaliasDisplayedProse("Calling mcp__exa_mcp__web_search_exa now.", ctx())).toBe(
					"Calling web_search_exa now.",
				);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("transforms streaming updates the same as finalized text (no finalize flicker)", () => {
			aliasExa();
			const input = "Searching via mcp__exa_mcp__web_search_exa...";
			const finalized = _test.unaliasDisplayedProse(input, ctx({ isStreaming: false }));
			const streaming = _test.unaliasDisplayedProse(input, ctx({ isStreaming: true }));
			expect(streaming).toBe("Searching via web_search_exa...");
			expect(streaming).toBe(finalized);
		});

		it("transforms assistant-thinking text", () => {
			aliasExa();
			expect(
				_test.unaliasDisplayedProse("Maybe mcp__exa_mcp__web_search_exa?", ctx({ messageType: "assistant-thinking" })),
			).toBe("Maybe web_search_exa?");
		});

		it("leaves user messages untouched", () => {
			aliasExa();
			const input = "please run mcp__exa_mcp__web_search_exa";
			expect(_test.unaliasDisplayedProse(input, ctx({ messageType: "user" }))).toBe(input);
		});

		it("leaves foreign mcp__ names untouched", () => {
			aliasExa();
			const input = "I'll call mcp__real_server__lookup for this.";
			expect(_test.unaliasDisplayedProse(input, ctx())).toBe(input);
		});

		it("resolves stale aliases via registeredAliasRoutes when the current mapping is gone", () => {
			// Alias was registered, then a config change removed its MCP_TO_FLAT
			// mapping; the permanent route must still resolve it (same precedence
			// as unaliasToolCalls).
			_test.registeredMcpAliases.add("mcp__exa__web_search");
			_test.registeredAliasRoutes.set("mcp__exa__web_search", "web_search_exa");

			expect(_test.unaliasDisplayedProse("Retry mcp__exa__web_search.", ctx())).toBe("Retry web_search_exa.");
		});

		it("rewrites mixed-case alias mentions (case-insensitive lookup)", () => {
			_test.refreshAliasMap([["my_tool", "MCP__Foo__Bar"]]);
			_test.registeredMcpAliases.add("mcp__foo__bar");

			expect(_test.unaliasDisplayedProse("Using MCP__Foo__Bar here.", ctx())).toBe("Using my_tool here.");
		});

		it("only rewrites whole tokens, not superstrings or embedded matches", () => {
			aliasExa();
			const input = "See mcp__exa_mcp__web_search_exa_v2 and foo_mcp__exa_mcp__web_search_exa.";
			expect(_test.unaliasDisplayedProse(input, ctx())).toBe(input);
		});

		it("returns the input unchanged when no aliases are registered", () => {
			const input = "Plain prose mentioning mcp__something__else and `code`.";
			expect(_test.unaliasDisplayedProse(input, ctx())).toBe(input);
		});

		it("does not invert system-prompt rewrites in displayed text", () => {
			aliasExa();
			// rewritePromptText substitutions apply only to the (never-rendered)
			// system prompt; prose about "the cli itself" must stay as written.
			const input = "Read about the cli itself, cli .md files, and cli packages.";
			expect(_test.unaliasDisplayedProse(input, ctx())).toBe(input);
		});

		it("can be disabled with PI_CLAUDE_CODE_USE_DISABLE_PROSE_UNALIAS=1", () => {
			vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_PROSE_UNALIAS", "1");
			try {
				aliasExa();
				const input = "Calling mcp__exa_mcp__web_search_exa.";
				expect(_test.unaliasDisplayedProse(input, ctx())).toBe(input);
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});
});
