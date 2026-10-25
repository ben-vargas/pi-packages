import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piClaudeCodeUse, { _test } from "../extensions/index.js";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

let scratch: string;
let agentDir: string;
let projectDir: string;

function writeConfig(dir: string, config: unknown): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "pi-claude-code-use.json"), JSON.stringify(config));
}

async function load() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerMarkdownTransformer: vi.fn(),
		registerTool: vi.fn(),
		getAllTools: vi.fn(() => [
			{
				name: "web_search_exa",
				description: "Search",
				parameters: {},
				exposure: "direct",
				sourceInfo: { path: "/x/node_modules/pi-exa/index.ts", source: "t", scope: "user", origin: "package" },
			},
		]),
		getActiveTools: vi.fn(() => ["read", "web_search_exa"]),
		setActiveTools: vi.fn(),
	};
	await piClaudeCodeUse(pi as unknown as ExtensionAPI);
	const ctx = {
		cwd: projectDir,
		model: { provider: "anthropic", id: "claude-sonnet-5-5" },
		modelRegistry: { isUsingOAuth: () => true },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Missing handler: ${name}`);
		return handler({ type: name, ...event }, ctx);
	};
	return { pi, emit };
}

const payload = {
	system: [{ type: "text", text: "Read the docs when asked about pi itself or pi packages." }],
	tools: [
		{ name: "Read", input_schema: {} },
		{ name: "web_search_exa", input_schema: {} },
	],
	tool_choice: { type: "tool", name: "web_search_exa" },
	messages: [
		{ role: "user", content: "Search" },
		{
			role: "system",
			content: [
				{ type: "text", text: "Mentions pi itself." },
				{
					type: "tool_addition",
					tool: { type: "tool_definition", definition: { name: "firecrawl_search", input_schema: {} } },
				},
			],
		},
	],
};

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-claude-default-"));
	agentDir = join(scratch, "agent");
	projectDir = join(scratch, "project");
	mkdirSync(projectDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_CLAUDE_CODE_USE_TOOL_ALIASES", "");
	_test.registeredMcpAliases.clear();
	_test.aliasAssignments.clear();
	_test.refreshAliasMap([]);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

describe("tool aliasing disabled", () => {
	beforeEach(() => {
		writeConfig(join(projectDir, ".pi", "extensions"), { toolAliasing: false });
	});

	it("rewrites only the system prompt and leaves tool names untouched", async () => {
		const { pi, emit } = await load();
		await emit("session_start");
		await emit("before_agent_start");
		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(pi.setActiveTools).not.toHaveBeenCalled();

		const original = structuredClone(payload);
		const result = (await emit("before_provider_request", { payload })) as typeof payload;
		expect(payload).toEqual(original);
		expect(result.system).toEqual([
			{ type: "text", text: "Read the docs when asked about the cli itself or cli packages." },
		]);
		expect(result.messages[1]).toEqual({
			...payload.messages[1],
			content: [{ type: "text", text: "Mentions the cli itself." }, payload.messages[1].content[1]],
		});
		expect(result.tools).toEqual(payload.tools);
		expect(result.tool_choice).toEqual(payload.tool_choice);
	});

	it("leaves assistant tool calls unchanged at message_end", async () => {
		const { emit } = await load();
		await emit("session_start");
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "mcp__exa__web_search_exa", arguments: {} }],
		};
		expect(await emit("message_end", { message })).toBeUndefined();
	});
});

describe("tool aliasing default and overrides", () => {
	it("is on by default, disabled by the config, and overridden by the env var", () => {
		expect(_test.isToolAliasingEnabled(projectDir, agentDir)).toBe(true);

		writeConfig(join(agentDir, "extensions"), { toolAliasing: false });
		expect(_test.isToolAliasingEnabled(projectDir, agentDir)).toBe(false);

		// The project config replaces the global key.
		writeConfig(join(projectDir, ".pi", "extensions"), { toolAliasing: true });
		expect(_test.isToolAliasingEnabled(projectDir, agentDir)).toBe(true);

		vi.stubEnv("PI_CLAUDE_CODE_USE_TOOL_ALIASES", "0");
		expect(_test.isToolAliasingEnabled(projectDir, agentDir)).toBe(false);
		writeConfig(join(projectDir, ".pi", "extensions"), { toolAliasing: false });
		vi.stubEnv("PI_CLAUDE_CODE_USE_TOOL_ALIASES", "1");
		expect(_test.isToolAliasingEnabled(projectDir, agentDir)).toBe(true);
	});

	it("registers and applies aliases without any configuration", async () => {
		const { pi, emit } = await load();
		await emit("session_start");
		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "mcp__exa__web_search_exa", exposure: "model-only" }),
		);

		const result = (await emit("before_provider_request", { payload })) as typeof payload;
		expect(result.tools.map((tool) => tool.name)).toEqual(["Read", "mcp__exa__web_search_exa"]);
		expect(result.tool_choice).toEqual({ type: "tool", name: "mcp__exa__web_search_exa" });
	});
});
