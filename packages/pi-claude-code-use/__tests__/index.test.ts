import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import piClaudeCodeUse, { _test } from "../extensions/index.js";

// ============================================================================
// Test helpers
// ============================================================================

/** Build a minimal ToolInfo-compatible object for test mocks. */
function mockTool(name: string, sourceOverrides?: { baseDir?: string; path?: string }) {
	return {
		name,
		description: "",
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
		registerMessageRenderer: vi.fn(),
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

// ============================================================================
// Tests
// ============================================================================

describe("pi-claude-code-use", () => {
	beforeEach(() => {
		_test.registeredMcpAliases.clear();
		_test.autoActivatedAliases.clear();
		_test.setLastManagedToolList(undefined);
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

	it("does not register alias tools when no companion source tools are loaded", async () => {
		const pi = createMockPi();
		pi.getAllTools.mockReturnValue([mockTool("read")]);
		await piClaudeCodeUse(pi as unknown as ExtensionAPI);

		expect(pi.registerTool).not.toHaveBeenCalled();
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

	it("renames known companion tools to MCP aliases when alias is advertised", () => {
		const result = _test.transformPayload(
			{
				tools: [
					{ name: "web_search_exa", description: "Flat", input_schema: {} },
					{ name: "mcp__exa__web_search", description: "Alias", input_schema: {} },
				],
				messages: [],
			},
			false,
		);

		expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual(["mcp__exa__web_search"]);
	});

	it("filters companion tools when MCP alias is not in the tool list", () => {
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
		const result = _test.transformPayload(
			{
				tools: [
					{ name: "web_search_exa", description: "Flat", input_schema: {} },
					{ name: "mcp__exa__web_search", description: "Alias", input_schema: {} },
					{ name: "totally_unknown", description: "Custom ext", input_schema: {} },
				],
				messages: [],
			},
			true,
		);

		expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual([
			"web_search_exa",
			"mcp__exa__web_search",
			"totally_unknown",
		]);
	});

	// ----------------------------------------------------------------
	// tool_choice remapping
	// ----------------------------------------------------------------

	it("remaps tool_choice from flat companion name to MCP alias", () => {
		const result = _test.transformPayload(
			{
				tool_choice: { type: "tool", name: "web_search_exa" },
				tools: [
					{ name: "web_search_exa", input_schema: {} },
					{ name: "mcp__exa__web_search", input_schema: {} },
				],
				messages: [],
			},
			false,
		);

		expect(result.tool_choice).toEqual({ type: "tool", name: "mcp__exa__web_search" });
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
					{ name: "mcp__exa__web_search", input_schema: {} },
				],
			},
			false,
		);

		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Searching..." },
					{ type: "tool_use", id: "toolu_abc", name: "mcp__exa__web_search", input: { q: "test" } },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: "done" }],
			},
		]);
	});

	it("preserves tool_use names when no MCP alias survives filtering", () => {
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
					{ name: "mcp__exa__web_search", description: "Alias", input_schema: {} },
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
			"mcp__exa__web_search",
			"mcp__custom__tool",
		]);

		// Must not inject metadata (that's Tier 2)
		expect("metadata" in result).toBe(false);
	});

	it("passes tools, tool_choice, and messages through unchanged with filter disabled", () => {
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
					{ name: "mcp__exa__web_search", description: "Alias", input_schema: {} },
					{ name: "custom_ext_tool", description: "Custom", input_schema: {} },
				],
			},
			true,
		);

		expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual([
			"web_search_exa",
			"mcp__exa__web_search",
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
	// Companion source matching
	// ----------------------------------------------------------------

	it("matches companion source by directory name from package root", () => {
		const spec = { dirName: "pi-exa-mcp", packageName: "@benvargas/pi-exa-mcp", aliases: [] as const };
		expect(
			_test.isCompanionSource(
				{
					name: "web_search_exa",
					sourceInfo: {
						baseDir: "/tmp/node_modules/@benvargas/pi-exa-mcp",
						path: "/tmp/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts",
					},
				} as never,
				spec,
			),
		).toBe(true);
	});

	it("matches companion source from extensions/ subdirectory layout", () => {
		const spec = { dirName: "pi-exa-mcp", packageName: "@benvargas/pi-exa-mcp", aliases: [] as const };
		expect(
			_test.isCompanionSource(
				{
					name: "web_search_exa",
					sourceInfo: {
						baseDir: "/worktree/packages/pi-exa-mcp/extensions",
						path: "/worktree/packages/pi-exa-mcp/extensions/index.ts",
					},
				} as never,
				spec,
			),
		).toBe(true);
	});

	it("rejects tools from unrelated extension directories", () => {
		const spec = {
			dirName: "pi-antigravity-image-gen",
			packageName: "@benvargas/pi-antigravity-image-gen",
			aliases: [] as const,
		};
		expect(
			_test.isCompanionSource(
				{
					name: "generate_image",
					sourceInfo: {
						baseDir: "/tmp/some-other-extension",
						path: "/tmp/some-other-extension/extensions/index.ts",
					},
				} as never,
				spec,
			),
		).toBe(false);
	});

	it("matches companion source via path when baseDir is absent", () => {
		const spec = { dirName: "pi-exa-mcp", packageName: "@benvargas/pi-exa-mcp", aliases: [] as const };
		expect(
			_test.isCompanionSource(
				{
					name: "web_search_exa",
					sourceInfo: {
						path: "/worktree/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts",
						source: "test",
						scope: "user" as const,
						origin: "package" as const,
					},
				} as never,
				spec,
			),
		).toBe(true);
	});

	it("rejects tools from packages whose names are prefixes of the companion package", () => {
		const spec = { dirName: "pi-exa-mcp", packageName: "@benvargas/pi-exa-mcp", aliases: [] as const };
		expect(
			_test.isCompanionSource(
				{
					name: "web_search_exa",
					sourceInfo: {
						path: "/worktree/node_modules/@benvargas/pi-exa-mcp-wrapper/extensions/index.ts",
						source: "test",
						scope: "user" as const,
						origin: "package" as const,
					},
				} as never,
				spec,
			),
		).toBe(false);
	});

	it("matches companion source via dirName fallback for monorepo/git installs", () => {
		const spec = { dirName: "pi-exa-mcp", packageName: "@benvargas/pi-exa-mcp", aliases: [] as const };
		expect(
			_test.isCompanionSource(
				{
					name: "web_search_exa",
					sourceInfo: {
						// baseDir is the monorepo root, not the individual package
						baseDir: "/home/user/.pi/agent/git/github.com/ben-vargas/pi-packages",
						path: "/home/user/.pi/agent/git/github.com/ben-vargas/pi-packages/packages/pi-exa-mcp/extensions/index.ts",
						source: "test",
						scope: "user" as const,
						origin: "package" as const,
					},
				} as never,
				spec,
			),
		).toBe(true);
	});

	it("matches companion source via Windows-style backslash paths", () => {
		const spec = { dirName: "pi-exa-mcp", packageName: "@benvargas/pi-exa-mcp", aliases: [] as const };
		expect(
			_test.isCompanionSource(
				{
					name: "web_search_exa",
					sourceInfo: {
						path: "C:\\Users\\dev\\node_modules\\@benvargas\\pi-exa-mcp\\extensions\\index.ts",
						source: "test",
						scope: "user" as const,
						origin: "package" as const,
					},
				} as never,
				spec,
			),
		).toBe(true);
	});

	// ----------------------------------------------------------------
	// Alias activation tracking
	// ----------------------------------------------------------------

	it("activates MCP aliases for active companion tools, then removes them on disable", () => {
		const pi = createMockPi();
		_test.registeredMcpAliases.add("mcp__exa__web_search");
		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa__web_search")]);
		pi.getActiveTools.mockReturnValue(["read", "web_search_exa"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "web_search_exa", "mcp__exa__web_search"]);

		// Now disable: should remove the alias
		pi.setActiveTools.mockClear();
		pi.getActiveTools.mockReturnValue(["read", "web_search_exa", "mcp__exa__web_search"]);

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
		_test.registeredMcpAliases.add("mcp__exa__web_search");
		_test.autoActivatedAliases.add("mcp__exa__web_search");
		_test.setLastManagedToolList(["read", "mcp__exa__web_search"]);

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa__web_search")]);
		// web_search_exa is NOT active, only the alias is (stale state)
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
	});

	it("preserves aliases the user explicitly enabled via the tool picker", () => {
		const pi = createMockPi();
		_test.registeredMcpAliases.add("mcp__exa__web_search");
		// Alias is NOT in autoActivatedAliases → user added it manually

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa__web_search")]);
		// web_search_exa is not active, but user manually enabled the MCP alias
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		// User-selected alias is preserved even without flat counterpart active
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("promotes auto-activated alias to user-selected when user removes flat but keeps alias", () => {
		const pi = createMockPi();
		_test.registeredMcpAliases.add("mcp__exa__web_search");
		_test.autoActivatedAliases.add("mcp__exa__web_search");
		// Last sync had both flat + alias active
		_test.setLastManagedToolList(["read", "web_search_exa", "mcp__exa__web_search"]);

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa__web_search")]);
		// User removed web_search_exa (was in last managed) but kept the MCP alias
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		// Alias promoted to user-selected → preserved even though flat is inactive
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("prunes auto-activated aliases when flat was never managed (no promotion)", () => {
		const pi = createMockPi();
		_test.registeredMcpAliases.add("mcp__exa__web_search");
		_test.autoActivatedAliases.add("mcp__exa__web_search");
		// Last sync did NOT include web_search_exa → flat was never managed
		_test.setLastManagedToolList(["read", "mcp__exa__web_search"]);

		pi.getAllTools.mockReturnValue([mockTool("web_search_exa"), mockTool("mcp__exa__web_search")]);
		pi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search"]);

		_test.syncAliasActivation(pi as unknown as ExtensionAPI, true);
		// Flat was never in managed list → no promotion, alias is pruned
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
	});

	it("does not auto-manage MCP aliases that were not registered by this extension", () => {
		const pi = createMockPi();
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

	// ----------------------------------------------------------------
	// Capture shim
	// ----------------------------------------------------------------

	it("does not forward flag registration to realPi and gates flag access through the capture shim", () => {
		const pi = {
			...createMockPi(),
			getFlag: vi.fn((_name: string) => "test-value"),
		};

		const captured = new Map();
		const shim = _test.buildCaptureShim(pi as unknown as ExtensionAPI, captured);

		// Before registration, shim returns undefined (flag not tracked)
		expect(shim.getFlag("--exa-mcp-tools")).toBeUndefined();

		// After registration, shim tracks in shimFlags and delegates getFlag to realPi
		shim.registerFlag("--exa-mcp-tools", { description: "tools", type: "string" });
		expect(pi.registerFlag).not.toHaveBeenCalled();
		expect(shim.getFlag("--exa-mcp-tools")).toBe("test-value");

		// Unregistered flags still return undefined through shim
		expect(shim.getFlag("--other-flag")).toBeUndefined();
	});

	// ----------------------------------------------------------------
	// before_provider_request handler (end-to-end)
	// ----------------------------------------------------------------

	async function getProviderRequestHandler(pi: ReturnType<typeof createMockPi>) {
		await piClaudeCodeUse(pi as unknown as ExtensionAPI);
		const hookCall = pi.on.mock.calls.find((c: unknown[]) => c[0] === "before_provider_request");
		return hookCall?.[1] as (event: { payload: unknown }, ctx: Record<string, unknown>) => unknown;
	}

	it("transforms payload when model is anthropic OAuth", async () => {
		const pi = createMockPi();
		const handler = await getProviderRequestHandler(pi);

		const ctx = {
			model: { provider: "anthropic", id: "claude-opus-4-6" },
			modelRegistry: { isUsingOAuth: () => true },
		};

		const result = handler(
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
	// Companion loading integration
	// ----------------------------------------------------------------

	it("registers MCP alias tools from companion extension factories", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "pi-claude-code-use-"));
		const tempRoot = join(tempParent, "pi-exa-mcp");
		try {
			const extDir = join(tempRoot, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(
				join(extDir, "index.js"),
				[
					'import { StringEnum } from "@mariozechner/pi-ai";',
					'import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";',
					'import { Type } from "@sinclair/typebox";',
					"const schema = Type.Object({ q: StringEnum(['web']) });",
					"export default function companion(pi) {",
					"  pi.registerTool({",
					'    name: "web_search_exa",',
					"    description: 'Search web ' + String(DEFAULT_MAX_BYTES),",
					"    inputSchema: schema,",
					"    async execute() { return { content: [{ type: 'text', text: String(DEFAULT_MAX_BYTES) }] }; }",
					"  });",
					"}",
				].join("\n"),
				"utf-8",
			);

			const pi = createMockPi();
			pi.getAllTools.mockReturnValue([
				mockTool("web_search_exa", { baseDir: tempRoot, path: join(extDir, "index.js") }),
			]);

			await _test.registerAliasesForLoadedCompanions(pi as unknown as ExtensionAPI);

			expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp__exa__web_search" }));
		} finally {
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	it("refuses to alias tools from unrelated packages even if names match", async () => {
		const pi = createMockPi();
		pi.getAllTools.mockReturnValue([
			mockTool("generate_image", {
				baseDir: "/tmp/node_modules/some-random-ext",
				path: "/tmp/node_modules/some-random-ext/extensions/index.ts",
			}),
		]);

		await _test.registerAliasesForLoadedCompanions(pi as unknown as ExtensionAPI);
		expect(pi.registerTool).not.toHaveBeenCalled();
	});
});
