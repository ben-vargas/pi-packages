import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
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
	tool?: { type: string; name?: string; definition?: { name: string; description?: string; input_schema?: unknown } };
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
const model = { ...getBuiltinModel("anthropic", "claude-fable-5-1"), baseUrl: "http://127.0.0.1:9" };
let scratch: string;

function tool(name: string): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: Type.Object({ query: Type.Optional(Type.String()) }),
		exposure: "direct",
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
			// Exercise Pi's real Anthropic adapter and the real request hook, aborting
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

/** Name of a tool change: a Pi 0.86 reference or a Pi 1.x inline definition. */
function changeName(block: WireBlock): string | undefined {
	return block.tool?.definition?.name ?? block.tool?.name;
}

function changes(payload: WirePayload) {
	return payload.messages.flatMap((message) =>
		Array.isArray(message.content)
			? message.content.filter((block) => block.type === "tool_addition" || block.type === "tool_removal")
			: [],
	);
}

// Tool aliasing is opt-in; these suites exercise it, so enable it per test.
beforeEach(() => {
	vi.stubEnv("PI_CLAUDE_CODE_USE_TOOL_ALIASES", "1");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

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

describe("Pi native Anthropic transcript updates", () => {
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
		// Pi 1.x keeps the top-level list fixed and defines later tools inline.
		expect(addition.after.tools).toEqual(initial.after.tools);
		expect(changes(addition.before).map(changeName)).toEqual(["firecrawl_search", FIRECRAWL_ALIAS]);
		expect(changes(addition.after)).toEqual([
			{
				type: "tool_addition",
				tool: {
					type: "tool_definition",
					definition: expect.objectContaining({
						name: FIRECRAWL_ALIAS,
						description: "firecrawl_search description",
					}),
				},
				cache_control: { type: "ephemeral" },
			},
		]);
		// No flat custom tool name reaches the OAuth wire.
		expect(JSON.stringify(addition.after)).not.toContain('"firecrawl_search"');
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
		expect(changes(removal.after).map((block) => [block.type, changeName(block)])).toEqual([
			["tool_addition", FIRECRAWL_ALIAS],
			["tool_removal", EXA_ALIAS],
		]);
		expect(removal.after.tools).toEqual(addition.after.tools);
		expect(JSON.stringify(removal.after)).not.toMatch(/"(web_search_exa|firecrawl_search)"/);
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

	it("keeps an inline redefinition of an active tool under its alias with the source schema", async () => {
		const runtime = await createRuntime();
		const context: Context = {
			messages: [
				{ role: "system", content: "Initial", toolsAdded: runtime.activeTools(), timestamp: 0 },
				{ role: "user", content: "First", timestamp: 1 },
			],
		};
		const initial = await runtime.capture(context);
		const updated = { ...tool("web_search_exa"), description: "Updated exa description" };
		// Pi adds a redefined tool again under the same name, without a removal.
		// The alias stub's schema can still be the previous one.
		context.messages.push({
			role: "system",
			content: "",
			toolsAdded: [tool(EXA_ALIAS), updated],
			timestamp: 2,
		});
		const { before, after } = await runtime.capture(context);
		expect(changes(before).map(changeName)).toEqual([EXA_ALIAS, "web_search_exa"]);
		expect(after.tools).toEqual(initial.after.tools);
		expect(changes(after)).toEqual([
			{
				type: "tool_addition",
				tool: {
					type: "tool_definition",
					definition: expect.objectContaining({ name: EXA_ALIAS, description: "Updated exa description" }),
				},
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	it("keeps the flat source schema when its alias definition follows it", () => {
		_test.refreshAliasMap([], [["web_search_exa", EXA_ALIAS]]);
		const definition = (name: string, description: string) => ({
			type: "tool_addition",
			tool: { type: "tool_definition", definition: { name, description, input_schema: {} } },
		});
		const result = _test.transformPayload(
			{
				tools: [{ name: "Read", input_schema: {} }],
				messages: [
					{
						role: "system",
						content: [definition("web_search_exa", "Current"), definition(EXA_ALIAS, "Stale")],
					},
				],
			},
			{ aliasTools: true },
		);
		expect(result.messages).toEqual([{ role: "system", content: [definition(EXA_ALIAS, "Current")] }]);
	});

	it("drops inline definitions of unaliased flat tools and moves their cache breakpoint", () => {
		const cache = { type: "ephemeral", ttl: "1h" };
		const user = { role: "user", content: [{ type: "text", text: "First" }] };
		const addition = {
			type: "tool_addition",
			tool: { type: "tool_definition", definition: { name: "unknown_flat", input_schema: {} } },
			cache_control: cache,
		};
		const result = _test.transformPayload(
			{ tools: [{ name: "Read", input_schema: {} }], messages: [user, { role: "system", content: [addition] }] },
			{ aliasTools: true },
		);
		expect(result.messages).toEqual([{ ...user, content: [{ type: "text", text: "First", cache_control: cache }] }]);
	});

	it("drops aliases whose active source Pi left undeclared, keeping user-selected aliases", () => {
		_test.refreshAliasMap(
			[],
			[
				["web_search_exa", EXA_ALIAS],
				["firecrawl_search", FIRECRAWL_ALIAS],
			],
		);
		_test.registeredMcpAliases.add(EXA_ALIAS);
		_test.registeredMcpAliases.add(FIRECRAWL_ALIAS);
		const cache = { type: "ephemeral" };
		const inline = (name: string) => ({
			type: "tool_addition",
			tool: { type: "tool_definition", definition: { name, input_schema: {} } },
		});
		const payload = {
			tools: [
				{ name: "Read", input_schema: {} },
				{ name: EXA_ALIAS, input_schema: {}, cache_control: cache },
			],
			messages: [{ role: "system", content: [inline(FIRECRAWL_ALIAS)] }],
		};
		// Both sources are active but undeclared, as when codemode-only mode hides them.
		const hidden = _test.transformPayload(payload, {
			aliasTools: true,
			activeToolNames: ["read", "web_search_exa", "firecrawl_search"],
		});
		expect(hidden.tools).toEqual([{ name: "Read", input_schema: {}, cache_control: cache }]);
		expect(hidden.messages).toEqual([]);

		// With the sources inactive, the aliases are the user's own selection.
		const selected = _test.transformPayload(payload, {
			aliasTools: true,
			activeToolNames: ["read", EXA_ALIAS, FIRECRAWL_ALIAS],
		});
		expect(selected.tools).toEqual(payload.tools);
		expect(selected.messages).toEqual(payload.messages);
	});

	it("remaps tool_choice to a tool that was only defined inline", () => {
		_test.refreshAliasMap([], [["firecrawl_search", FIRECRAWL_ALIAS]]);
		_test.registeredMcpAliases.add(FIRECRAWL_ALIAS);
		const result = _test.transformPayload(
			{
				tools: [{ name: "Read", input_schema: {} }],
				tool_choice: { type: "tool", name: "firecrawl_search" },
				messages: [
					{
						role: "system",
						content: [
							{
								type: "tool_addition",
								tool: { type: "tool_definition", definition: { name: "firecrawl_search", input_schema: {} } },
							},
						],
					},
				],
			},
			{ aliasTools: true },
		);
		expect(result.tool_choice).toEqual({ type: "tool", name: FIRECRAWL_ALIAS });
		expect(JSON.stringify(result)).not.toContain('"firecrawl_search"');
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
		const result = _test.transformPayload(raw, { aliasTools: true });
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
			{ aliasTools: true },
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
			{ aliasTools: true },
		);
		expect(result.messages).toEqual([message]);
	});

	it("does not invent cache markers when caching is disabled or no preceding eligible block exists", () => {
		const user = { role: "user", content: "First" };
		const change = { type: "tool_addition", tool: { type: "tool_reference", name: "unknown_flat" } };
		expect(
			_test.transformPayload(
				{ tools: [], messages: [user, { role: "system", content: [change] }] },
				{ aliasTools: true },
			).messages,
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
				{ aliasTools: true },
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
			{ aliasTools: true },
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
			{ aliasTools: true },
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
			{ aliasTools: true },
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
			{ aliasTools: true },
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
