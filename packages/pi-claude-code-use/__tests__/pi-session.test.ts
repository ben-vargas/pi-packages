import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piClaudeCodeUse, { _test } from "../extensions/index.js";

// Runs the extension inside a real Pi session (loader, tool registry, loadout
// hooks, nested-call context) and Pi's real Anthropic request builder. Requests
// are captured before they are sent; no network or credentials are used.

const model = getBuiltinModel("anthropic", "claude-fable-5-1");
let scratch: string;

async function createSession(options: { codemode?: "only" } = {}) {
	const settings = SettingsManager.inMemory(options.codemode ? { codemode: { mode: options.codemode } } : {});
	let api: ExtensionAPI | undefined;
	const loader = new DefaultResourceLoader({
		cwd: scratch,
		agentDir: scratch,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [
			...(options.codemode ? [createCodemodeExtension({ mode: options.codemode, models: false })] : []),
			(pi) =>
				pi.registerTool({
					name: "web_search_exa",
					label: "Exa",
					description: "Search",
					parameters: Type.Object({ query: Type.String() }),
					execute: async (_id, params) => ({
						content: [{ type: "text", text: `source ran: ${params.query}` }],
						details: {},
					}),
				}),
			(pi) => {
				api = pi;
				return piClaudeCodeUse(pi);
			},
		],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(scratch, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(scratch, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	vi.spyOn(modelRuntime, "isUsingOAuth").mockReturnValue(true);
	const { session } = await createAgentSession({
		cwd: scratch,
		agentDir: scratch,
		resourceLoader: loader,
		settingsManager: settings,
		sessionManager: SessionManager.inMemory(),
		modelRuntime,
		model,
	});
	await session.bindExtensions({});
	if (!api) throw new Error("Extension API was not captured");
	return { session, api };
}

// Tool aliasing is opt-in; these suites exercise it, so enable it per test.
beforeEach(() => {
	vi.stubEnv("PI_CLAUDE_CODE_USE_TOOL_ALIASES", "1");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-claude-session-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", scratch);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER", "0");
	vi.stubEnv("PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS", "0");
	for (const state of [
		_test.registeredMcpAliases,
		_test.autoActivatedAliases,
		_test.aliasAssignments,
		_test.registeredAliasRoutes,
		_test.aliasSourceMeta,
		_test.aliasExactNames,
	]) {
		state.clear();
	}
	_test.setLastManagedToolList(undefined);
	_test.refreshAliasMap([]);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(scratch, { recursive: true, force: true });
});

describe("pi-claude-code-use in a Pi session", () => {
	it("hides alias declarations with their source in codemode-only mode", async () => {
		const { session, api } = await createSession({ codemode: "only" });
		try {
			session.setActiveToolsByName(["codemode", "web_search_exa"]);
			_test.syncAliasActivation(api, true);
			const alias = _test.FLAT_TO_MCP.get("web_search_exa");
			expect(alias).toBeDefined();
			expect(session.getActiveToolNames()).toContain(alias);

			const declared = session.agent.state.tools.map(({ name, description, parameters }) => ({
				name,
				description,
				parameters,
			}));
			const transformContext = session.agent.transformContext;
			if (!transformContext) throw new Error("Pi installed no context projection");
			const messages = await transformContext([
				{ role: "system", content: "Test", toolsAdded: declared, timestamp: 0 },
				{ role: "user", content: "Search", timestamp: 1 },
			] as never);
			let wire: { tools?: Array<{ name: string }> } | undefined;
			await stream(model, normalizeContext({ messages } as never), {
				apiKey: "sk-ant-oat-test-never-sent",
				fetch: async () => {
					throw new Error("Network is forbidden in this test");
				},
				onPayload: (payload) => {
					// The request hook passes pi.getActiveTools() the same way.
					wire = _test.transformPayload(payload as Record<string, unknown>, {
						aliasTools: true,
						activeToolNames: api.getActiveTools(),
					});
					throw new Error("Payload captured");
				},
			}).result();

			const names = wire?.tools?.map((tool) => tool.name) ?? [];
			// codemode itself is a flat tool, so it is declared under its own alias.
			expect(names).toContain(_test.FLAT_TO_MCP.get("codemode"));
			expect(names).not.toContain(alias);
			expect(names).not.toContain("web_search_exa");
		} finally {
			session.dispose();
		}
	});

	it("keeps aliases out of nested calls, so ctx.executeTool() reaches only the source tool", async () => {
		const { session, api } = await createSession();
		try {
			_test.syncAliasActivation(api, true);
			const alias = _test.FLAT_TO_MCP.get("web_search_exa");
			if (!alias) throw new Error("No alias was derived");
			expect(session.getActiveToolNames()).toContain(alias);
			expect(session.getCallableToolNames()).toContain("web_search_exa");
			expect(session.getCallableToolNames()).not.toContain(alias);
		} finally {
			session.dispose();
		}
	});
});
