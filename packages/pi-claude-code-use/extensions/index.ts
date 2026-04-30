import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createJiti } from "@mariozechner/jiti";
import * as piAgentCoreModule from "@mariozechner/pi-agent-core";
import * as piAiModule from "@mariozechner/pi-ai";
import * as piAiOauthModule from "@mariozechner/pi-ai/oauth";
import * as piCodingAgentModule from "@mariozechner/pi-coding-agent";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import * as piTuiModule from "@mariozechner/pi-tui";
import * as typeboxModule from "typebox";
import * as typeboxCompileModule from "typebox/compile";
import * as typeboxValueModule from "typebox/value";

// ============================================================================
// Types
// ============================================================================

interface CompanionSpec {
	dirName: string;
	packageName: string;
	aliases: ReadonlyArray<readonly [flatName: string, mcpName: string]>;
}

type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

// ============================================================================
// Constants
// ============================================================================

/**
 * Core Claude Code tool names that always pass through Anthropic OAuth filtering.
 * Stored lowercase for case-insensitive matching.
 * Mirrors Pi core's claudeCodeTools list in packages/ai/src/providers/anthropic.ts
 */
const CORE_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob",
	"askuserquestion",
	"enterplanmode",
	"exitplanmode",
	"killshell",
	"notebookedit",
	"skill",
	"task",
	"taskoutput",
	"todowrite",
	"webfetch",
	"websearch",
]);

/** Flat companion tool name → MCP-style alias. */
const FLAT_TO_MCP = new Map<string, string>([
	["web_search_exa", "mcp__exa__web_search"],
	["get_code_context_exa", "mcp__exa__get_code_context"],
	["firecrawl_scrape", "mcp__firecrawl__scrape"],
	["firecrawl_map", "mcp__firecrawl__map"],
	["firecrawl_search", "mcp__firecrawl__search"],
]);

/** Known companion extensions and the tools they provide. */
const COMPANIONS: CompanionSpec[] = [
	{
		dirName: "pi-exa-mcp",
		packageName: "@benvargas/pi-exa-mcp",
		aliases: [
			["web_search_exa", "mcp__exa__web_search"],
			["get_code_context_exa", "mcp__exa__get_code_context"],
		],
	},
	{
		dirName: "pi-firecrawl",
		packageName: "@benvargas/pi-firecrawl",
		aliases: [
			["firecrawl_scrape", "mcp__firecrawl__scrape"],
			["firecrawl_map", "mcp__firecrawl__map"],
			["firecrawl_search", "mcp__firecrawl__search"],
		],
	},
];

/** Reverse lookup: flat tool name → its companion spec. */
const TOOL_TO_COMPANION = new Map<string, CompanionSpec>(
	COMPANIONS.flatMap((spec) => spec.aliases.map(([flat]) => [flat, spec] as const)),
);

// ============================================================================
// User-defined tool aliases (pi-claude-code-use.json)
//
//   - project: <cwd>/.pi/extensions/pi-claude-code-use.json
//   - global:  <agentDir>/extensions/pi-claude-code-use.json   (agentDir from pi)
//
// Project file's keys replace global file's via spread-merge — same effective
// behaviour as pi-core's deepMergeSettings for our top-level array key.
// Schema: { "toolAliases": [[flat, mcp], ...] }
// ============================================================================

const CONFIG_FILENAME = "pi-claude-code-use.json";

type ToolAliasPair = readonly [flatName: string, mcpName: string];

function readConfigFile(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		return isPlainObject(parsed) ? parsed : {};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-claude-code-use] Failed to read ${filePath}: ${message}`);
		return {};
	}
}

// Returns `undefined` when `toolAliases` is missing or not an array; returns
// `[]` for an explicit empty array (which disables inherited globals).
function extractToolAliasPairs(value: unknown): ToolAliasPair[] | undefined {
	if (!isPlainObject(value)) return undefined;
	const raw = (value as { toolAliases?: unknown }).toolAliases;
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		console.warn(`[pi-claude-code-use] Ignoring "toolAliases": expected array, got ${typeof raw}`);
		return undefined;
	}
	return raw.filter(
		(e): e is ToolAliasPair => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string",
	);
}

function loadToolAliases(cwd: string, agentDir: string = getAgentDir()): ToolAliasPair[] {
	const globalPath = join(agentDir, "extensions", CONFIG_FILENAME);
	const projectPath = join(cwd, ".pi", "extensions", CONFIG_FILENAME);
	const merged = { ...readConfigFile(globalPath), ...readConfigFile(projectPath) };
	return extractToolAliasPairs(merged) ?? [];
}

// ============================================================================
// Helpers
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(name: string | undefined): string {
	return (name ?? "").trim().toLowerCase();
}

// ============================================================================
// System prompt rewrite (PRD §1.1)
//
// Replace "pi itself" → "the cli itself" in system prompt text.
// Preserves cache_control, non-text blocks, and payload shape.
// ============================================================================

function rewritePromptText(text: string): string {
	return text
		.replaceAll("pi itself", "the cli itself")
		.replaceAll("pi .md files", "cli .md files")
		.replaceAll("pi packages", "cli packages");
}

function rewriteSystemField(system: unknown): unknown {
	if (typeof system === "string") {
		return rewritePromptText(system);
	}
	if (!Array.isArray(system)) {
		return system;
	}
	return system.map((block) => {
		if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
			return block;
		}
		const rewritten = rewritePromptText(block.text);
		return rewritten === block.text ? block : { ...block, text: rewritten };
	});
}

// ============================================================================
// Tool filtering and MCP alias remapping (PRD §1.2)
//
// Rules applied per tool:
// 1. Anthropic-native typed tools (have a `type` field) → pass through
// 2. Core Claude Code tool names → pass through
// 3. Tools already prefixed with mcp__ → pass through
// 4. Known companion tools whose MCP alias is also advertised → rename to alias
// 5. Known companion tools without an advertised alias → filtered out
// 6. Unknown flat-named tools → filtered out (unless disableFilter)
// ============================================================================

function collectToolNames(tools: unknown[]): Set<string> {
	const names = new Set<string>();
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === "string") {
			names.add(lower(tool.name));
		}
	}
	return names;
}

function collectToolsByName(tools: unknown[]): Map<string, Record<string, unknown>> {
	const byName = new Map<string, Record<string, unknown>>();
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === "string") {
			byName.set(lower(tool.name), tool);
		}
	}
	return byName;
}

function filterAndRemapTools(tools: unknown[] | undefined, disableFilter: boolean): unknown[] | undefined {
	if (!Array.isArray(tools)) return tools;

	const advertised = collectToolNames(tools);
	const toolsByName = collectToolsByName(tools);
	const emitted = new Set<string>();
	const result: unknown[] = [];

	for (const tool of tools) {
		if (!isPlainObject(tool)) continue;

		// Rule 1: native typed tools always pass through
		if (typeof tool.type === "string" && tool.type.trim().length > 0) {
			result.push(tool);
			continue;
		}

		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const nameLc = lower(name);

		// Rules 2 & 3: core tools and mcp__-prefixed pass through (with dedup)
		if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) {
			if (!emitted.has(nameLc)) {
				emitted.add(nameLc);
				result.push(tool);
			}
			continue;
		}

		// Rules 4 & 5: known companion tool
		const mcpAlias = FLAT_TO_MCP.get(nameLc);
		if (mcpAlias) {
			const aliasLc = lower(mcpAlias);
			if (advertised.has(aliasLc) && !emitted.has(aliasLc)) {
				// Alias exists in tool list -> preserve its metadata, including cache_control.
				emitted.add(aliasLc);
				result.push(toolsByName.get(aliasLc) ?? { ...tool, name: mcpAlias });
			} else if (disableFilter && !emitted.has(nameLc)) {
				// Filter disabled: keep flat name if not yet emitted
				emitted.add(nameLc);
				result.push(tool);
			}
			continue;
		}

		// Rule 6: unknown flat-named tool
		if (disableFilter && !emitted.has(nameLc)) {
			emitted.add(nameLc);
			result.push(tool);
		}
	}

	return result;
}

function remapToolChoice(
	toolChoice: Record<string, unknown>,
	survivingNames: Map<string, string>,
): Record<string, unknown> | undefined {
	if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string") {
		return toolChoice;
	}

	const nameLc = lower(toolChoice.name);
	const actualName = survivingNames.get(nameLc);
	if (actualName) {
		return actualName === toolChoice.name ? toolChoice : { ...toolChoice, name: actualName };
	}

	const mcpAlias = FLAT_TO_MCP.get(nameLc);
	if (mcpAlias && survivingNames.has(lower(mcpAlias))) {
		return { ...toolChoice, name: mcpAlias };
	}

	return undefined;
}

function remapMessageToolNames(messages: unknown[], survivingNames: Map<string, string>): unknown[] {
	let anyChanged = false;
	const result = messages.map((msg) => {
		if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;

		let msgChanged = false;
		const content = (msg.content as unknown[]).map((block) => {
			if (!isPlainObject(block) || block.type !== "tool_use" || typeof block.name !== "string") {
				return block;
			}
			const mcpAlias = FLAT_TO_MCP.get(lower(block.name));
			if (mcpAlias && survivingNames.has(lower(mcpAlias))) {
				msgChanged = true;
				return { ...block, name: mcpAlias };
			}
			return block;
		});

		if (msgChanged) {
			anyChanged = true;
			return { ...msg, content };
		}
		return msg;
	});

	return anyChanged ? result : messages;
}

// ============================================================================
// Full payload transform
// ============================================================================

function transformPayload(raw: Record<string, unknown>, disableFilter: boolean): Record<string, unknown> {
	// Deep clone to avoid mutating the original
	const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

	// 1. System prompt rewrite (always applies)
	if (payload.system !== undefined) {
		payload.system = rewriteSystemField(payload.system);
	}

	// When escape hatch is active, skip all tool filtering/remapping
	if (disableFilter) {
		return payload;
	}

	// 2. Tool filtering and alias remapping
	payload.tools = filterAndRemapTools(payload.tools as unknown[] | undefined, false);

	// 3. Build map of tool names that survived filtering (lowercase → actual name)
	const survivingNames = new Map<string, string>();
	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			if (isPlainObject(tool) && typeof tool.name === "string") {
				survivingNames.set(lower(tool.name), tool.name as string);
			}
		}
	}

	// 4. Remap tool_choice if it references a renamed or filtered tool
	if (isPlainObject(payload.tool_choice)) {
		const remapped = remapToolChoice(payload.tool_choice, survivingNames);
		if (remapped === undefined) {
			delete payload.tool_choice;
		} else {
			payload.tool_choice = remapped;
		}
	}

	// 5. Rewrite historical tool_use blocks in message history
	if (Array.isArray(payload.messages)) {
		payload.messages = remapMessageToolNames(payload.messages, survivingNames);
	}

	return payload;
}

// ============================================================================
// Debug logging (PRD §1.4)
// ============================================================================

const debugLogPath = process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG;

function writeDebugLog(payload: unknown): void {
	if (!debugLogPath) return;
	try {
		appendFileSync(debugLogPath, `${new Date().toISOString()}\n${JSON.stringify(payload, null, 2)}\n---\n`, "utf-8");
	} catch {
		// Debug logging must never break actual requests
	}
}

// ============================================================================
// Companion alias registration (PRD §1.3)
//
// Discovers loaded companion extensions, captures their tool definitions via
// a shim ExtensionAPI, and registers MCP-alias versions so the model can
// invoke them under Claude Code-compatible names.
// ============================================================================

const registeredMcpAliases = new Set<string>();
const autoActivatedAliases = new Set<string>();
let lastManagedToolList: string[] | undefined;

const captureCache = new Map<string, Promise<Map<string, ToolRegistration>>>();
let jitiLoader: { import(path: string, opts?: { default?: boolean }): Promise<unknown> } | undefined;

function getJitiLoader() {
	if (!jitiLoader) {
		jitiLoader = createJiti(import.meta.url, {
			moduleCache: false,
			tryNative: false,
			virtualModules: {
				"@mariozechner/pi-agent-core": piAgentCoreModule,
				"@mariozechner/pi-ai": piAiModule,
				"@mariozechner/pi-ai/oauth": piAiOauthModule,
				"@mariozechner/pi-coding-agent": piCodingAgentModule,
				"@mariozechner/pi-tui": piTuiModule,
				typebox: typeboxModule,
				"typebox/compile": typeboxCompileModule,
				"typebox/value": typeboxValueModule,
				"@sinclair/typebox": typeboxModule,
				"@sinclair/typebox/compile": typeboxCompileModule,
				"@sinclair/typebox/value": typeboxValueModule,
			},
		});
	}
	return jitiLoader;
}

async function loadFactory(baseDir: string): Promise<((pi: ExtensionAPI) => void | Promise<void>) | undefined> {
	const dir = baseDir.replace(/\/$/, "");
	const candidates = [`${dir}/index.ts`, `${dir}/index.js`, `${dir}/extensions/index.ts`, `${dir}/extensions/index.js`];

	const loader = getJitiLoader();
	for (const path of candidates) {
		try {
			const mod = await loader.import(path, { default: true });
			if (typeof mod === "function") return mod as (pi: ExtensionAPI) => void | Promise<void>;
		} catch {
			// Try next candidate
		}
	}
	return undefined;
}

function isCompanionSource(tool: ToolInfo | undefined, spec: CompanionSpec): boolean {
	if (!tool?.sourceInfo) return false;

	const baseDir = tool.sourceInfo.baseDir;
	if (baseDir) {
		const dirName = basename(baseDir);
		if (dirName === spec.dirName) return true;
		if (dirName === "extensions" && basename(dirname(baseDir)) === spec.dirName) return true;
	}

	const fullPath = tool.sourceInfo.path;
	if (typeof fullPath !== "string") return false;
	// Normalize backslashes for Windows paths before segment-bounded check
	const normalized = fullPath.replaceAll("\\", "/");
	// Check for scoped package name (npm install) or directory name (git/monorepo)
	return normalized.includes(`/${spec.packageName}/`) || normalized.includes(`/${spec.dirName}/`);
}

function buildCaptureShim(realPi: ExtensionAPI, captured: Map<string, ToolRegistration>): ExtensionAPI {
	const shimFlags = new Set<string>();
	return {
		registerTool(def) {
			captured.set(def.name, def as unknown as ToolRegistration);
		},
		registerFlag(name, _options) {
			shimFlags.add(name);
		},
		getFlag(name) {
			return shimFlags.has(name) ? realPi.getFlag(name) : undefined;
		},
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerProvider() {},
		unregisterProvider() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		setSessionName() {},
		getSessionName() {
			return undefined;
		},
		setLabel() {},
		exec(command, args, options) {
			return realPi.exec(command, args, options);
		},
		getActiveTools() {
			return realPi.getActiveTools();
		},
		getAllTools() {
			return realPi.getAllTools();
		},
		setActiveTools(names) {
			realPi.setActiveTools(names);
		},
		getCommands() {
			return realPi.getCommands();
		},
		setModel(model) {
			return realPi.setModel(model);
		},
		getThinkingLevel() {
			return realPi.getThinkingLevel();
		},
		setThinkingLevel(level) {
			realPi.setThinkingLevel(level);
		},
		events: realPi.events,
	} as ExtensionAPI;
}

async function captureCompanionTools(baseDir: string, realPi: ExtensionAPI): Promise<Map<string, ToolRegistration>> {
	let pending = captureCache.get(baseDir);
	if (!pending) {
		pending = (async () => {
			const factory = await loadFactory(baseDir);
			if (!factory) return new Map<string, ToolRegistration>();
			const tools = new Map<string, ToolRegistration>();
			await factory(buildCaptureShim(realPi, tools));
			return tools;
		})();
		captureCache.set(baseDir, pending);
	}
	return pending;
}

async function registerMcpAliases(pi: ExtensionAPI, opts: { cwd?: string; agentDir?: string } = {}): Promise<void> {
	// Clear capture cache so flag/config changes since last call take effect
	captureCache.clear();

	// Pick up user-defined tool aliases from settings.json so subsequent payload
	// transforms (filterAndRemapTools, remapToolChoice, message rewriting) see them.
	const userToolAliases = loadToolAliases(opts.cwd ?? process.cwd(), opts.agentDir);
	for (const [flat, mcp] of userToolAliases) FLAT_TO_MCP.set(lower(flat), mcp);

	const allTools = pi.getAllTools();
	const toolIndex = new Map<string, ToolInfo>();
	const knownNames = new Set<string>();
	for (const tool of allTools) {
		toolIndex.set(lower(tool.name), tool);
		knownNames.add(lower(tool.name));
	}

	// Loads the source extension via jiti and re-registers its captured tool
	// definition under `mcpName`. Skips if already registered or unloadable.
	const registerMcpAlias = async (tool: ToolInfo | undefined, flatName: string, mcpName: string): Promise<void> => {
		if (!tool || registeredMcpAliases.has(mcpName) || knownNames.has(lower(mcpName))) return;
		// Prefer the extension file's directory (sourceInfo.path is the actual entry
		// point). Fall back to baseDir, which can be the monorepo root.
		const loadDir = tool.sourceInfo?.path ? dirname(tool.sourceInfo.path) : tool.sourceInfo?.baseDir;
		if (!loadDir) return;
		const def = (await captureCompanionTools(loadDir, pi)).get(flatName);
		if (!def) return;
		pi.registerTool({
			...def,
			name: mcpName,
			label: def.label?.startsWith("MCP ") ? def.label : `MCP ${def.label ?? mcpName}`,
		});
		registeredMcpAliases.add(mcpName);
		knownNames.add(lower(mcpName));
	};

	// Built-in companion aliases: gated by source-info match against COMPANIONS.
	for (const spec of COMPANIONS) {
		for (const [flatName, mcpName] of spec.aliases) {
			const tool = toolIndex.get(lower(flatName));
			if (tool && !isCompanionSource(tool, spec)) continue;
			await registerMcpAlias(tool, flatName, mcpName);
		}
	}

	// User-defined aliases: matched by flat name only.
	for (const [flatName, mcpName] of userToolAliases) {
		await registerMcpAlias(toolIndex.get(lower(flatName)), flatName, mcpName);
	}
}

/**
 * Synchronize MCP alias tool activation with the current model state.
 * When OAuth is active, auto-activate aliases for any active companion tools.
 * When OAuth is inactive, remove auto-activated aliases (but preserve user-selected ones).
 */
function syncAliasActivation(pi: ExtensionAPI, enableAliases: boolean): void {
	const activeNames = pi.getActiveTools();
	const allNames = new Set(pi.getAllTools().map((t) => t.name));

	if (enableAliases) {
		// Determine which aliases should be active based on their flat counterpart being active
		const activeLc = new Set(activeNames.map(lower));
		const desiredAliases: string[] = [];
		for (const [flat, mcp] of FLAT_TO_MCP) {
			if (activeLc.has(flat) && allNames.has(mcp) && registeredMcpAliases.has(mcp)) {
				desiredAliases.push(mcp);
			}
		}
		const desiredSet = new Set(desiredAliases);

		// Promote auto-activated aliases to user-selected when the user explicitly kept
		// the alias while removing its flat counterpart from the tool picker.
		// We detect this by checking: (a) user changed the tool list since our last sync,
		// (b) the flat tool was previously managed but is no longer active, and
		// (c) the alias is still active. This means the user deliberately kept the alias.
		if (lastManagedToolList !== undefined) {
			const activeSet = new Set(activeNames);
			const lastManaged = new Set(lastManagedToolList);
			for (const alias of autoActivatedAliases) {
				if (!activeSet.has(alias) || desiredSet.has(alias)) continue;
				// Find the flat name for this alias
				const flatName = [...FLAT_TO_MCP.entries()].find(([, mcp]) => mcp === alias)?.[0];
				if (flatName && lastManaged.has(flatName) && !activeSet.has(flatName)) {
					// User removed the flat tool but kept the alias → promote to user-selected
					autoActivatedAliases.delete(alias);
				}
			}
		}

		// Find registered aliases currently in the active list
		const activeRegistered = activeNames.filter((n) => registeredMcpAliases.has(n) && allNames.has(n));

		// Per-alias provenance: an alias is "user-selected" if it's active and was NOT
		// auto-activated by us. Only preserve those; auto-activated aliases get re-derived
		// from the desired set each sync.
		const preserved = activeRegistered.filter((n) => !autoActivatedAliases.has(n));

		// Build result: non-alias tools + preserved user aliases + desired aliases
		const nonAlias = activeNames.filter((n) => !registeredMcpAliases.has(n));
		const next = Array.from(new Set([...nonAlias, ...preserved, ...desiredAliases]));

		// Update auto-activation tracking: aliases we added this sync that weren't user-preserved
		const preservedSet = new Set(preserved);
		autoActivatedAliases.clear();
		for (const name of desiredAliases) {
			if (!preservedSet.has(name)) {
				autoActivatedAliases.add(name);
			}
		}

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
			lastManagedToolList = [...next];
		}
	} else {
		// Remove only auto-activated aliases; user-selected ones are preserved
		const next = activeNames.filter((n) => !autoActivatedAliases.has(n));
		autoActivatedAliases.clear();

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
			lastManagedToolList = [...next];
		} else {
			lastManagedToolList = undefined;
		}
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default async function piClaudeCodeUse(pi: ExtensionAPI): Promise<void> {
	pi.on("session_start", async () => {
		await registerMcpAliases(pi);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await registerMcpAliases(pi);
		const model = ctx.model;
		const isOAuth = model?.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model);
		syncAliasActivation(pi, isOAuth);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(model)) {
			return undefined;
		}
		if (!isPlainObject(event.payload)) {
			return undefined;
		}

		writeDebugLog({ stage: "before", payload: event.payload });
		const disableFilter = process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER === "1";
		const transformed = transformPayload(event.payload as Record<string, unknown>, disableFilter);
		writeDebugLog({ stage: "after", payload: transformed });
		return transformed;
	});
}

// ============================================================================
// Test exports
// ============================================================================

export const _test = {
	CORE_TOOL_NAMES,
	FLAT_TO_MCP,
	COMPANIONS,
	TOOL_TO_COMPANION,
	autoActivatedAliases,
	buildCaptureShim,
	collectToolNames,
	extractToolAliasPairs,
	filterAndRemapTools,
	getLastManagedToolList: () => lastManagedToolList,
	isCompanionSource,
	isPlainObject,
	loadToolAliases,
	lower,
	registerMcpAliases,
	registeredMcpAliases,
	remapMessageToolNames,
	remapToolChoice,
	rewritePromptText,
	rewriteSystemField,
	setLastManagedToolList: (v: string[] | undefined) => {
		lastManagedToolList = v;
	},
	syncAliasActivation,
	transformPayload,
};
