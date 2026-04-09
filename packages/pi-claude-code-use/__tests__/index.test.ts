import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import piClaudeCodeUse, { _test } from "../extensions/index.js";

type MockPi = {
	events: ExtensionAPI["events"];
	exec: ReturnType<typeof vi.fn>;
	getActiveTools: ReturnType<typeof vi.fn>;
	getAllTools: ReturnType<typeof vi.fn>;
	getCommands: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	getSessionName: ReturnType<typeof vi.fn>;
	getThinkingLevel: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
	setLabel: ReturnType<typeof vi.fn>;
	setModel: ReturnType<typeof vi.fn>;
	setSessionName: ReturnType<typeof vi.fn>;
	setThinkingLevel: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	registerTool: ReturnType<typeof vi.fn>;
	registerProvider: ReturnType<typeof vi.fn>;
	registerShortcut: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	unregisterProvider: ReturnType<typeof vi.fn>;
};

function createMockPi(): MockPi {
	return {
		appendEntry: vi.fn(),
		events: {} as ExtensionAPI["events"],
		exec: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
		getCommands: vi.fn(() => []),
		getFlag: vi.fn(() => undefined),
		getSessionName: vi.fn(() => undefined),
		getThinkingLevel: vi.fn(() => "medium"),
		on: vi.fn(),
		registerCommand: vi.fn(),
		registerFlag: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerTool: vi.fn(),
		registerProvider: vi.fn(),
		registerShortcut: vi.fn(),
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

describe("pi-claude-code-use", () => {
	beforeEach(() => {
		_test.autoActivatedAliasNames.clear();
		_test.setLastAutoManagedToolNames(undefined);
		_test.registeredAliasNames.clear();
	});

	it("registers only extension hooks and does not override the anthropic provider", async () => {
		const mockPi = createMockPi();
		await piClaudeCodeUse(mockPi as unknown as ExtensionAPI);

		expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("before_provider_request", expect.any(Function));
		expect(mockPi.registerProvider).not.toHaveBeenCalled();
	});

	it("does not call runtime-only tool APIs during extension load", async () => {
		const mockPi = createMockPi();
		mockPi.getAllTools.mockImplementation(() => {
			throw new Error("runtime not initialized");
		});
		mockPi.getActiveTools.mockImplementation(() => {
			throw new Error("runtime not initialized");
		});

		await expect(piClaudeCodeUse(mockPi as unknown as ExtensionAPI)).resolves.toBeUndefined();
	});

	it("does not eagerly register companion aliases when the source tools are not loaded", async () => {
		const mockPi = createMockPi();
		mockPi.getAllTools.mockReturnValue([{ name: "read", sourceInfo: {} }]);

		await piClaudeCodeUse(mockPi as unknown as ExtensionAPI);

		expect(mockPi.registerTool).not.toHaveBeenCalled();
	});

	it("rewrites only the minimum Anthropic OAuth system prompt text and tool list", () => {
		const transformed = _test.transformAnthropicOAuthPayload({
			model: "claude-opus-4-6",
			system: [
				{
					type: "text",
					text: "You are Claude Code, Anthropic's official CLI for Claude.",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
				{
					type: "text",
					text: "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Fix the bug." }],
				},
			],
			tools: [
				{ name: "Read", description: "Read files", input_schema: { type: "object", properties: {} } },
				{ type: "web_search", name: "web_search", search_context_size: "high" },
				{ name: "web_search_exa", description: "Search web", input_schema: { type: "object", properties: {} } },
				{
					name: "mcp__exa__web_search",
					description: "Search web alias",
					input_schema: { type: "object", properties: {} },
				},
				{
					name: "mcp__custom__lookup",
					description: "Already MCP-shaped",
					input_schema: { type: "object", properties: {} },
				},
				{ name: "totally_unknown_tool", description: "Unknown", input_schema: { type: "object", properties: {} } },
			],
		});

		expect(transformed.system).toEqual([
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
			{
				type: "text",
				text: "Pi documentation (read only when the user asks about the cli itself, its SDK, extensions, themes, skills, or TUI):",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		]);
		expect(transformed.tools?.map((tool) => tool.name ?? tool.type)).toEqual([
			"Read",
			"web_search",
			"mcp__exa__web_search",
			"mcp__custom__lookup",
		]);
		expect("metadata" in transformed).toBe(false);
	});

	it("preserves non-text system blocks while rewriting text system blocks", () => {
		const nonTextBlock = { type: "guard_content", guard: "keep-me" };
		const transformed = _test.transformAnthropicOAuthPayload({
			system: [
				{
					type: "text",
					text: "Pi documentation (read only when the user asks about pi itself):",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
				nonTextBlock,
			],
			messages: [{ role: "user", content: "hello" }],
		});

		expect(transformed.system).toEqual([
			{
				type: "text",
				text: "Pi documentation (read only when the user asks about the cli itself):",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
			nonTextBlock,
		]);
	});

	it("preserves string-form system prompts while rewriting text content", () => {
		const transformed = _test.transformAnthropicOAuthPayload({
			system: "Pi documentation (read only when the user asks about pi itself):",
			messages: [{ role: "user", content: "hello" }],
		});

		expect(transformed.system).toBe("Pi documentation (read only when the user asks about the cli itself):");
	});

	it("maps known monorepo tools to MCP aliases and preserves existing MCP names", () => {
		const advertisedToolNames = new Set([
			"mcp__exa__web_search",
			"mcp__exa__get_code_context",
			"mcp__firecrawl__scrape",
		]);

		expect(_test.getClaudeCodeVisibleToolName("web_search_exa", advertisedToolNames)).toBe("mcp__exa__web_search");
		expect(_test.getClaudeCodeVisibleToolName("get_code_context_exa", advertisedToolNames)).toBe(
			"mcp__exa__get_code_context",
		);
		expect(_test.getClaudeCodeVisibleToolName("firecrawl_scrape", advertisedToolNames)).toBe("mcp__firecrawl__scrape");
		expect(_test.getClaudeCodeVisibleToolName("mcp__custom__lookup", advertisedToolNames)).toBe("mcp__custom__lookup");
		expect(_test.getClaudeCodeVisibleToolName("Read", advertisedToolNames)).toBe("Read");
		expect(_test.getClaudeCodeVisibleToolName("totally_unknown_tool", advertisedToolNames)).toBeUndefined();
	});

	it("filters known companion tools when the MCP alias is not advertised", () => {
		const transformed = _test.transformAnthropicOAuthPayload({
			system: [{ type: "text", text: "Pi documentation (read only when the user asks about pi itself):" }],
			messages: [{ role: "user", content: "Search now." }],
			tools: [{ name: "web_search_exa", description: "Original", input_schema: { type: "object", properties: {} } }],
		});

		expect(transformed.tools).toEqual([]);
	});

	it("deduplicates tool names after alias remapping", () => {
		const transformed = _test.transformAnthropicOAuthPayload({
			system: [{ type: "text", text: "Pi documentation (read only when the user asks about pi itself):" }],
			messages: [{ role: "user", content: "Search now." }],
			tools: [
				{ name: "web_search_exa", description: "Original", input_schema: { type: "object", properties: {} } },
				{
					name: "mcp__exa__web_search",
					description: "Alias",
					input_schema: { type: "object", properties: {} },
				},
			],
		});

		expect(transformed.tools?.map((tool) => tool.name)).toEqual(["mcp__exa__web_search"]);
	});

	it("rewrites legacy tool_use names in prior assistant messages when the alias is advertised", () => {
		const transformed = _test.transformAnthropicOAuthPayload({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Searching..." },
						{ type: "tool_use", id: "toolu_123", name: "web_search_exa", input: { q: "pi" } },
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "done" }],
				},
			],
			tools: [
				{ name: "web_search_exa", description: "Original", input_schema: { type: "object", properties: {} } },
				{
					name: "mcp__exa__web_search",
					description: "Alias",
					input_schema: { type: "object", properties: {} },
				},
			],
		});

		expect(transformed.messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Searching..." },
					{ type: "tool_use", id: "toolu_123", name: "mcp__exa__web_search", input: { q: "pi" } },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "done" }],
			},
		]);
	});

	it("preserves prior tool_use names when no advertised MCP alias exists", () => {
		const transformed = _test.transformAnthropicOAuthPayload({
			messages: [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "toolu_123", name: "web_search_exa", input: { q: "pi" } }],
				},
			],
			tools: [{ name: "web_search_exa", description: "Original", input_schema: { type: "object", properties: {} } }],
		});

		expect(transformed.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_123", name: "web_search_exa", input: { q: "pi" } }],
			},
		]);
	});

	it("keeps alias remapping and deduplication active when tool filtering is disabled", () => {
		const transformed = _test.transformAnthropicOAuthPayload(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "toolu_123", name: "web_search_exa", input: { q: "pi" } }],
					},
				],
				tool_choice: { type: "tool", name: "web_search_exa" },
				tools: [
					{ name: "web_search_exa", description: "Original", input_schema: { type: "object", properties: {} } },
					{
						name: "mcp__exa__web_search",
						description: "Alias",
						input_schema: { type: "object", properties: {} },
					},
					{ name: "totally_unknown_tool", description: "Unknown", input_schema: { type: "object", properties: {} } },
				],
			},
			{ disableToolFiltering: true },
		);

		expect(transformed.tools?.map((tool) => tool.name)).toEqual(["mcp__exa__web_search", "totally_unknown_tool"]);
		expect(transformed.tool_choice).toEqual({ type: "tool", name: "mcp__exa__web_search" });
		expect(transformed.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_123", name: "mcp__exa__web_search", input: { q: "pi" } }],
			},
		]);
	});

	it("adds extension-registered MCP aliases and removes only those aliases when disabling", () => {
		const mockPi = createMockPi();
		mockPi.getAllTools.mockReturnValue([
			{ name: "web_search_exa", sourceInfo: {} },
			{ name: "mcp__exa__web_search", sourceInfo: {} },
		]);
		mockPi.getActiveTools.mockReturnValue(["read", "web_search_exa"]);

		_test.syncKnownAliasToolActivation(mockPi as unknown as ExtensionAPI, true);

		expect(mockPi.setActiveTools).toHaveBeenCalledWith(["read", "web_search_exa", "mcp__exa__web_search"]);

		mockPi.setActiveTools.mockClear();
		_test.registeredAliasNames.add("mcp__exa__web_search");
		mockPi.getActiveTools.mockReturnValue(["read", "web_search_exa", "mcp__exa__web_search"]);

		_test.syncKnownAliasToolActivation(mockPi as unknown as ExtensionAPI, false);

		expect(mockPi.setActiveTools).toHaveBeenCalledWith(["read", "web_search_exa"]);
	});

	it("preserves user-provided MCP tools when disabling aliases", () => {
		const mockPi = createMockPi();
		mockPi.getAllTools.mockReturnValue([{ name: "mcp__exa__web_search", sourceInfo: {} }]);
		mockPi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search"]);

		_test.syncKnownAliasToolActivation(mockPi as unknown as ExtensionAPI, false);

		expect(mockPi.setActiveTools).not.toHaveBeenCalled();
	});

	it("prunes stale extension-registered aliases when enabling aliases", () => {
		const mockPi = createMockPi();
		_test.registeredAliasNames.add("mcp__exa__web_search");
		_test.autoActivatedAliasNames.add("mcp__exa__web_search");
		_test.setLastAutoManagedToolNames(["read", "mcp__exa__web_search"]);
		mockPi.getAllTools.mockReturnValue([
			{ name: "web_search_exa", sourceInfo: {} },
			{ name: "mcp__exa__web_search", sourceInfo: {} },
		]);
		mockPi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search"]);

		_test.syncKnownAliasToolActivation(mockPi as unknown as ExtensionAPI, true);

		expect(mockPi.setActiveTools).toHaveBeenCalledWith(["read"]);
	});

	it("preserves extension-registered aliases users enabled directly", () => {
		const mockPi = createMockPi();
		_test.registeredAliasNames.add("mcp__exa__web_search");
		_test.autoActivatedAliasNames.add("mcp__exa__web_search");
		_test.setLastAutoManagedToolNames(["read", "web_search_exa", "mcp__exa__web_search"]);
		mockPi.getAllTools.mockReturnValue([{ name: "mcp__exa__web_search", sourceInfo: {} }]);
		mockPi.getActiveTools.mockReturnValue(["read", "mcp__exa__web_search"]);

		_test.syncKnownAliasToolActivation(mockPi as unknown as ExtensionAPI, true);

		expect(mockPi.setActiveTools).not.toHaveBeenCalled();
	});

	it("capture shim preserves companion flag access after flag registration", () => {
		const mockPi = createMockPi();
		const registeredFlags = new Set<string>();
		mockPi.registerFlag.mockImplementation((name: string) => {
			registeredFlags.add(name);
		});
		mockPi.getFlag.mockImplementation((name: string) => {
			if (!registeredFlags.has(name)) {
				return undefined;
			}
			return name === "--exa-mcp-tools" ? "web_search_exa" : undefined;
		});

		const capturedTools = new Map();
		const capturePi = _test.createCapturePi(mockPi as unknown as ExtensionAPI, capturedTools);

		expect(capturePi.getFlag("--exa-mcp-tools")).toBeUndefined();
		capturePi.registerFlag("--exa-mcp-tools", { description: "tools", type: "string" });
		expect(mockPi.registerFlag).toHaveBeenCalledWith("--exa-mcp-tools", { description: "tools", type: "string" });
		expect(capturePi.getFlag("--exa-mcp-tools")).toBe("web_search_exa");
	});

	it("recognizes companion package sources from package root and extensions dir layouts", () => {
		expect(
			_test.matchesCompanionExtensionSource(
				{
					name: "web_search_exa",
					sourceInfo: {
						baseDir: "/tmp/node_modules/@benvargas/pi-exa-mcp",
						path: "/tmp/node_modules/@benvargas/pi-exa-mcp/extensions/index.ts",
					},
				} as never,
				{
					baseDirName: "pi-exa-mcp",
					packageName: "@benvargas/pi-exa-mcp",
					toolAliases: [],
				},
			),
		).toBe(true);

		expect(
			_test.matchesCompanionExtensionSource(
				{
					name: "web_search_exa",
					sourceInfo: {
						baseDir: "/tmp/worktree/packages/pi-exa-mcp/extensions",
						path: "/tmp/worktree/packages/pi-exa-mcp/extensions/index.ts",
					},
				} as never,
				{
					baseDirName: "pi-exa-mcp",
					packageName: "@benvargas/pi-exa-mcp",
					toolAliases: [],
				},
			),
		).toBe(true);
	});

	it("does not treat unrelated tools with matching names as companion aliases", () => {
		expect(
			_test.matchesCompanionExtensionSource(
				{
					name: "generate_image",
					sourceInfo: {
						baseDir: "/tmp/node_modules/some-other-extension",
						path: "/tmp/node_modules/some-other-extension/extensions/index.ts",
					},
				} as never,
				{
					baseDirName: "pi-antigravity-image-gen",
					packageName: "@benvargas/pi-antigravity-image-gen",
					toolAliases: [],
				},
			),
		).toBe(false);
	});

	it("registers alias tools from companion package-root layouts", async () => {
		const tempParent = mkdtempSync(join(tmpdir(), "pi-claude-code-use-"));
		const tempRoot = join(tempParent, "pi-exa-mcp");
		try {
			const extensionsDir = join(tempRoot, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(
				join(extensionsDir, "index.js"),
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
					"",
				].join("\n"),
				"utf8",
			);

			const mockPi = createMockPi();
			mockPi.getAllTools.mockReturnValue([
				{
					name: "web_search_exa",
					sourceInfo: {
						baseDir: tempRoot,
						path: join(tempRoot, "extensions", "index.js"),
					},
				},
			]);

			await _test.registerKnownMonorepoToolAliases(mockPi as unknown as ExtensionAPI);

			expect(mockPi.registerTool).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "mcp__exa__web_search",
				}),
			);
		} finally {
			rmSync(tempParent, { recursive: true, force: true });
		}
	});

	it("does not alias unrelated matching tool names in non-eager registration", async () => {
		const mockPi = createMockPi();
		mockPi.getAllTools.mockReturnValue([
			{
				name: "generate_image",
				sourceInfo: {
					baseDir: "/tmp/node_modules/some-other-extension",
					path: "/tmp/node_modules/some-other-extension/extensions/index.ts",
				},
			},
		]);

		await _test.registerKnownMonorepoToolAliases(mockPi as unknown as ExtensionAPI);

		expect(mockPi.registerTool).not.toHaveBeenCalled();
	});
});
