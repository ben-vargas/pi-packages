import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getModel, normalizeContext } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piClaudeCodeUse, { _test } from "../extensions/index.js";

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
interface WireBlock {
	type: string;
	text?: string;
	tool?: { type: string; name: string };
	cache_control?: unknown;
}
interface WirePayload {
	system: WireBlock[];
	tools: Array<{ name: string; defer_loading?: boolean; cache_control?: unknown }>;
	messages: Array<{ role: string; content: string | WireBlock[]; output_config?: unknown }>;
}

const PLACEHOLDER = "__pi_deferred_placeholder__";
const EXA_ALIAS = "mcp__review__web_search_exa";
const FIRECRAWL_ALIAS = "mcp__review__firecrawl_search";
const model = { ...getModel("anthropic", "claude-fable-5-1"), baseUrl: "http://127.0.0.1:9" };
let scratch: string;

function tool(name: string): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: Type.Object({ query: Type.Optional(Type.String()) }),
		sourceInfo: { path: "/packages/pi-review/extensions/index.ts", source: "test", scope: "user", origin: "package" },
	};
}

async function createRuntime() {
	const registered = new Map<string, ToolInfo>();
	let active: string[] = [];
	const handlers = new Map<string, Handler>();
	const addTool = (value: ToolInfo) => {
		if (!registered.has(value.name)) active.push(value.name);
		registered.set(value.name, value);
	};
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerMarkdownTransformer: vi.fn(),
		getAllTools: () => [...registered.values()],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		registerTool: (definition: ToolRegistration) => addTool({ ...tool(definition.name), ...definition }),
	};
	const ctx = { cwd: scratch, model, modelRegistry: { isUsingOAuth: () => true } } as unknown as ExtensionContext;
	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Missing handler: ${name}`);
		return handler({ type: name, ...event }, ctx);
	};
	addTool(tool("read"));
	addTool(tool("web_search_exa"));
	await piClaudeCodeUse(api as unknown as ExtensionAPI);
	await emit("session_start");
	await emit("before_agent_start");

	return {
		addTool,
		emit,
		setActive: api.setActiveTools,
		activeTools: (): Tool[] => [...registered.values()].filter((value) => active.includes(value.name)),
		async capture(context: Context): Promise<{ before: WirePayload; after: WirePayload }> {
			let captured: { before: WirePayload; after: WirePayload } | undefined;
			const fetch = vi.fn(async () => {
				throw new Error("Network is forbidden in this regression test");
			});
			// Exercise the real 0.86 adapter and the real request hook, aborting
			// before any request is sent. No user credentials or provider calls.
			const result = await stream(model, normalizeContext(context), {
				apiKey: "sk-ant-oat-test-never-sent",
				fetch,
				onPayload: async (payload) => {
					const before = structuredClone(payload) as WirePayload;
					const after = (await emit("before_provider_request", { payload })) as WirePayload;
					expect(payload).toEqual(before);
					captured = { before, after };
					throw new Error("Payload captured");
				},
			}).result();
			expect(fetch).not.toHaveBeenCalled();
			if (!captured) throw new Error(result.errorMessage ?? "Payload capture failed");
			return captured;
		},
	};
}

function changes(payload: WirePayload) {
	return payload.messages.flatMap((message) =>
		Array.isArray(message.content)
			? message.content.filter((block) => block.type === "tool_addition" || block.type === "tool_removal")
			: [],
	);
}

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-086-claude-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(scratch, "agent"));
	vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER", "0");
	vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS", "0");
	vi.stubEnv("PI_CLAUDE_CODE_USE_DEBUG_LOG", "");
	_test.registeredMcpAliases.clear();
	_test.autoActivatedAliases.clear();
	_test.aliasAssignments.clear();
	_test.registeredAliasRoutes.clear();
	_test.aliasSourceMeta.clear();
	_test.aliasExactNames.clear();
	_test.setLastManagedToolList(undefined);
	_test.refreshAliasMap([]);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

describe("Pi 0.86 native Anthropic transcript updates", () => {
	it("keeps historical aliases stable through request-hook refreshes when definitions disappear", async () => {
		const runtime = await createRuntime();
		const history = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Searching..." },
					{
						type: "tool_use",
						id: "toolu_history",
						name: "web_search_exa",
						input: { query: "Pi compatibility" },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_history",
						content: [{ type: "text", text: "Found results" }],
						is_error: false,
						cache_control: { type: "ephemeral" },
					},
				],
			},
		];
		const expected = [
			{
				...history[0],
				content: [history[0].content[0], { ...history[0].content[1], name: EXA_ALIAS }],
			},
			history[1],
		];
		const initialActive = runtime.activeTools().map((value) => value.name);
		const results: unknown[] = [];

		// Keep the source in getAllTools while omitting both outgoing definitions.
		// Each request runs the real hook, including its alias-map rebuild.
		for (const active of [initialActive, ["read"], initialActive]) {
			runtime.setActive(active);
			await runtime.emit("before_agent_start");
			const payload = {
				tools: runtime.activeTools().map((value) => ({
					name: value.name === "read" ? "Read" : value.name,
					input_schema: value.parameters,
				})),
				messages: history,
				tool_choice: { type: "tool", name: "web_search_exa" },
			};
			const original = structuredClone(payload);
			const result = (await runtime.emit("before_provider_request", { payload })) as Record<string, unknown>;
			expect(payload).toEqual(original);
			expect(_test.FLAT_TO_MCP.get("web_search_exa")).toBe(EXA_ALIAS);
			if (active.length === 1) {
				expect((result.tools as Array<{ name: string }>).map((value) => value.name)).toEqual(["Read"]);
				expect(result.tool_choice).toBeUndefined();
			} else {
				expect(result.tool_choice).toEqual({ type: "tool", name: EXA_ALIAS });
			}
			results.push(result.messages);
		}

		// IDs, inputs, tool-result pairing, and cache metadata remain identical.
		expect(results).toEqual([expected, expected, expected]);
	});

	it("preserves the initial deferred prefix and remaps additions, removals, and system text", async () => {
		expect(model.compat?.supportsMidConvoToolChanges).toBe(true);
		const runtime = await createRuntime();
		const initialTools = runtime.activeTools();
		const context: Context = {
			messages: [
				{ role: "system", content: "Ask about pi itself.", toolsAdded: initialTools, timestamp: 0 },
				{ role: "user", content: "pi itself", timestamp: 1 },
			],
		};
		const initial = await runtime.capture(context);
		expect(initial.after.tools.map((value) => value.name)).toEqual(["Read", EXA_ALIAS, PLACEHOLDER]);
		expect(initial.after.tools.at(-1)).toEqual(initial.before.tools.at(-1));
		expect(initial.after.tools.at(-1)?.defer_loading).toBe(true);

		runtime.addTool(tool("firecrawl_search"));
		await runtime.emit("before_agent_start");
		const added = runtime.activeTools().filter((value) => !initialTools.some((old) => old.name === value.name));
		context.messages.push(
			{
				role: "system",
				content: "Read pi .md files about pi packages and pi itself.",
				toolsAdded: added,
				timestamp: 2,
			},
			{ role: "user", content: "pi packages", timestamp: 3 },
		);
		const addition = await runtime.capture(context);
		expect(addition.after.tools.slice(0, initial.after.tools.length)).toEqual(initial.after.tools);
		expect(addition.after.tools.at(-1)).toMatchObject({ name: FIRECRAWL_ALIAS, defer_loading: true });
		expect(changes(addition.after)).toEqual([
			{
				type: "tool_addition",
				tool: { type: "tool_reference", name: FIRECRAWL_ALIAS },
				cache_control: { type: "ephemeral" },
			},
		]);
		expect(JSON.stringify(addition.after.messages)).toContain(
			"Read cli .md files about cli packages and the cli itself.",
		);
		expect(
			addition.after.messages.filter((message) => message.role === "user").map((message) => message.content),
		).toEqual(["pi itself", "pi packages"]);

		runtime.setActive(["read", "firecrawl_search", FIRECRAWL_ALIAS]);
		await runtime.emit("before_agent_start");
		context.messages.push({
			role: "system",
			content: "",
			toolsRemoved: [{ name: "web_search_exa" }, { name: EXA_ALIAS }],
			timestamp: 4,
		});
		const removal = await runtime.capture(context);
		expect(changes(removal.after).map((block) => [block.type, block.tool?.name])).toEqual([
			["tool_addition", FIRECRAWL_ALIAS],
			["tool_removal", EXA_ALIAS],
		]);
		for (const block of changes(removal.after)) {
			expect(removal.after.tools.some((value) => value.name === block.tool?.name)).toBe(true);
		}
		expect(removal.after.tools).toEqual(addition.after.tools);
	});

	it("keeps a selected alias available when its flat source is removed and restored", async () => {
		const runtime = await createRuntime();
		const context: Context = {
			messages: [
				{ role: "system", content: "Initial", toolsAdded: runtime.activeTools(), timestamp: 0 },
				{ role: "user", content: "First", timestamp: 1 },
			],
		};
		runtime.setActive(["read", EXA_ALIAS]);
		await runtime.emit("before_agent_start");
		context.messages.push({ role: "system", content: "", toolsRemoved: [{ name: "web_search_exa" }], timestamp: 2 });
		const removedSource = await runtime.capture(context);
		expect(changes(removedSource.after)).toEqual([]);
		expect(removedSource.after.messages.some((message) => message.role === "system" && message.output_config)).toBe(
			true,
		);

		runtime.setActive(["read", "web_search_exa", EXA_ALIAS]);
		await runtime.emit("before_agent_start");
		context.messages.push({ role: "system", content: "", toolsAdded: [tool("web_search_exa")], timestamp: 3 });
		expect(changes((await runtime.capture(context)).after)).toEqual([]);

		runtime.setActive(["read"]);
		await runtime.emit("before_agent_start");
		context.messages.push({
			role: "system",
			content: "",
			toolsRemoved: [{ name: "web_search_exa" }, { name: EXA_ALIAS }],
			timestamp: 4,
		});
		expect(changes((await runtime.capture(context)).after)).toMatchObject([
			{ type: "tool_removal", tool: { name: EXA_ALIAS } },
		]);
	});

	it("keeps an initially active alias non-deferred when its flat source is declared later", async () => {
		const runtime = await createRuntime();
		runtime.setActive(["read", EXA_ALIAS]);
		await runtime.emit("before_agent_start");
		const context: Context = {
			messages: [
				{ role: "system", content: "Initial", toolsAdded: runtime.activeTools(), timestamp: 0 },
				{ role: "user", content: "First", timestamp: 1 },
			],
		};
		const initial = await runtime.capture(context);
		runtime.setActive(["read", "web_search_exa", EXA_ALIAS]);
		await runtime.emit("before_agent_start");
		context.messages.push({ role: "system", content: "", toolsAdded: [tool("web_search_exa")], timestamp: 2 });
		const later = await runtime.capture(context);
		expect(later.after.tools).toEqual(initial.after.tools);
		expect(changes(later.after)).toEqual([]);
	});

	it.each(["filtered", "redundant"])(
		"preserves the history cache breakpoint when a trailing %s tool update disappears",
		async (kind) => {
			vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS", kind === "filtered" ? "1" : "0");
			const runtime = await createRuntime();
			const context: Context = {
				messages: [
					{ role: "system", content: "Initial", toolsAdded: runtime.activeTools(), timestamp: 0 },
					{ role: "user", content: "First", timestamp: 1 },
				],
			};
			const initial = await runtime.capture(context);
			runtime.setActive(kind === "filtered" ? ["read"] : ["read", EXA_ALIAS]);
			await runtime.emit("before_agent_start");
			context.messages.push({
				role: "system",
				content: "",
				toolsRemoved: [{ name: "web_search_exa" }],
				timestamp: 2,
			});
			const { before, after } = await runtime.capture(context);
			const cache = changes(before).at(-1)?.cache_control;
			expect(cache).toEqual({ type: "ephemeral" });
			expect(changes(after)).toEqual([]);
			expect(after.messages.find((message) => message.role === "user")?.content).toEqual([
				{ type: "text", text: "First", cache_control: cache },
			]);
			expect(
				after.messages.flatMap((message) =>
					Array.isArray(message.content) ? message.content.filter((block) => block.cache_control !== undefined) : [],
				),
			).toHaveLength(1);
			expect(after.messages.filter((message) => message.output_config)).toEqual(
				before.messages.filter((message) => message.output_config),
			);
			expect(after.system).toEqual(initial.after.system);
			expect(after.tools).toEqual(initial.after.tools);
		},
	);

	it.each([
		{ type: "text", text: "Earlier user input" },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } },
		{
			type: "tool_result",
			tool_use_id: "toolu_read",
			content: [{ type: "text", text: "File contents" }],
			is_error: false,
		},
	])("moves a removed breakpoint onto a preceding $type block without changing its data", (block) => {
		const cache = { type: "ephemeral", ttl: "1h" };
		const preceding = { role: "user", content: [block] };
		const assistant = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Reasoning", signature: "signature" },
				{ type: "text", text: "Assistant text" },
				{ type: "tool_use", id: "toolu_read", name: "Read", input: { path: "README.md" } },
			],
		};
		const effort = { role: "system", content: [], output_config: { effort: "high" } };
		const raw = {
			tools: [{ name: "Read", input_schema: {} }],
			messages: [
				preceding,
				assistant,
				effort,
				{
					role: "system",
					content: [
						{ type: "tool_removal", tool: { type: "tool_reference", name: "unknown_flat" }, cache_control: cache },
					],
				},
			],
		};
		const original = structuredClone(raw);
		const result = _test.transformPayload(raw, false);
		expect(result.messages).toEqual([
			{ ...preceding, content: [{ ...block, cache_control: cache }] },
			assistant,
			effort,
		]);
		expect(raw).toEqual(original);
	});

	it("restores a breakpoint to an earlier tool update while retaining effort-only messages", () => {
		const cache = { type: "ephemeral", ttl: "1h" };
		const first = { type: "tool_addition", tool: { type: "tool_reference", name: "mcp__foreign__tool" } };
		const result = _test.transformPayload(
			{
				tools: [{ name: "mcp__foreign__tool", input_schema: {}, defer_loading: true }],
				messages: [
					{ role: "system", content: [first] },
					{
						role: "system",
						content: [
							{ type: "tool_addition", tool: { type: "tool_reference", name: "unknown_flat" }, cache_control: cache },
						],
						output_config: { effort: "high" },
					},
				],
			},
			false,
		);
		expect(result.messages).toEqual([
			{ role: "system", content: [{ ...first, cache_control: cache }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		]);
	});

	it("keeps an existing breakpoint and TTL when multiple later marked updates disappear", () => {
		const cache = { type: "ephemeral", ttl: "1h" };
		const message = { role: "user", content: [{ type: "text", text: "First", cache_control: cache }] };
		const result = _test.transformPayload(
			{
				tools: [],
				messages: [
					message,
					...["tool_addition", "tool_removal"].map((type) => ({
						role: "system",
						content: [
							{ type, tool: { type: "tool_reference", name: "unknown_flat" }, cache_control: { type: "ephemeral" } },
						],
					})),
				],
			},
			false,
		);
		expect(result.messages).toEqual([message]);
	});

	it("does not invent cache markers when caching is disabled or no preceding eligible block exists", () => {
		const user = { role: "user", content: "First" };
		const change = { type: "tool_addition", tool: { type: "tool_reference", name: "unknown_flat" } };
		expect(
			_test.transformPayload({ tools: [], messages: [user, { role: "system", content: [change] }] }, false).messages,
		).toEqual([user]);
		const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "Reasoning", signature: "sig" }] };
		const effort = { role: "system", content: [], output_config: { effort: "high" } };
		expect(
			_test.transformPayload(
				{
					tools: [],
					messages: [
						assistant,
						effort,
						{ role: "system", content: [{ ...change, cache_control: { type: "ephemeral" } }] },
						user,
					],
				},
				false,
			).messages,
		).toEqual([assistant, effort, user]);
	});

	it("does not duplicate a cache breakpoint while merging flat and alias updates", () => {
		_test.refreshAliasMap([], [["web_search_exa", EXA_ALIAS]]);
		const cache = { type: "ephemeral" };
		const result = _test.transformPayload(
			{
				tools: [
					{ name: "web_search_exa", input_schema: {}, defer_loading: true },
					{ name: EXA_ALIAS, input_schema: {}, defer_loading: true },
				],
				messages: [
					{
						role: "system",
						content: [
							{ type: "tool_addition", tool: { type: "tool_reference", name: "web_search_exa" }, cache_control: cache },
							{ type: "tool_addition", tool: { type: "tool_reference", name: EXA_ALIAS } },
							{ type: "text", text: "Additional guidance" },
						],
					},
				],
			},
			false,
		);
		expect(result.messages).toEqual([
			{
				role: "system",
				content: [
					{ type: "tool_addition", tool: { type: "tool_reference", name: EXA_ALIAS }, cache_control: cache },
					{ type: "text", text: "Additional guidance" },
				],
			},
		]);
	});

	it("rewrites only system text when filtering is disabled", async () => {
		vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER", "1");
		const runtime = await createRuntime();
		const { before, after } = await runtime.capture({
			messages: [
				{ role: "system", content: "pi itself", toolsAdded: runtime.activeTools(), timestamp: 0 },
				{ role: "user", content: "pi itself", timestamp: 1 },
				{ role: "system", content: "pi packages", toolsRemoved: [{ name: "web_search_exa" }], timestamp: 2 },
			],
		});
		expect(after.tools).toEqual(before.tools);
		expect(changes(after)).toEqual(changes(before));
		expect(after.messages.filter((message) => message.role !== "system")).toEqual(
			before.messages.filter((message) => message.role !== "system"),
		);
		expect(after.system.at(-1)?.text).toBe("the cli itself");
		expect(
			after.messages
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.some((block) => block.text === "cli packages"),
		).toBe(true);
	});

	it("drops references to filtered tools, retaining direct MCP changes and cache metadata", () => {
		const cache = { type: "ephemeral", ttl: "1h" };
		const result = _test.transformPayload(
			{
				tools: [
					{ name: "Read", input_schema: {} },
					{ name: "unknown_flat", input_schema: {}, defer_loading: true },
					{ name: "mcp__foreign__tool", input_schema: {}, defer_loading: true },
				],
				messages: [
					{
						role: "system",
						content: [
							{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__foreign__tool" } },
							{ type: "tool_addition", tool: { type: "tool_reference", name: "unknown_flat" }, cache_control: cache },
						],
					},
					{
						role: "system",
						content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "unknown_flat" } }],
					},
					{ role: "system", content: [], output_config: { effort: "high" } },
				],
			},
			false,
		);
		expect(result.messages).toEqual([
			{
				role: "system",
				content: [
					{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__foreign__tool" }, cache_control: cache },
				],
			},
			{ role: "system", content: [], output_config: { effort: "high" } },
		]);
	});

	it("preserves only Pi's reserved deferred placeholder, not arbitrary deferred flat tools", () => {
		const placeholder = {
			name: PLACEHOLDER,
			description: "Reserved",
			input_schema: { type: "object" },
			defer_loading: true,
		};
		const result = _test.transformPayload(
			{
				tools: [
					placeholder,
					{ name: "other_placeholder", input_schema: {}, defer_loading: true },
					{ name: PLACEHOLDER, input_schema: {} },
				],
				messages: [],
			},
			false,
		);
		expect(result.tools).toEqual([placeholder]);
	});

	it("leaves user/assistant text, tool inputs, and non-text system blocks unchanged", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "pi itself" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "pi packages" },
					{ type: "tool_use", name: "Read", input: { path: "pi .md files" } },
				],
			},
		];
		const result = _test.transformPayload(
			{
				tools: [],
				messages: [
					...messages,
					{
						role: "system",
						content: [
							{ type: "opaque", text: "pi itself" },
							{ type: "text", text: "pi itself", cache_control: { type: "ephemeral" } },
						],
						output_config: { effort: "low" },
					},
				],
			},
			false,
		);
		expect((result.messages as unknown[]).slice(0, 2)).toEqual(messages);
		expect((result.messages as unknown[]).at(-1)).toEqual({
			role: "system",
			content: [
				{ type: "opaque", text: "pi itself" },
				{ type: "text", text: "the cli itself", cache_control: { type: "ephemeral" } },
			],
			output_config: { effort: "low" },
		});
	});
});
