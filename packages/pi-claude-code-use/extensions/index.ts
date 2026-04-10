import { appendFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createJiti } from "@mariozechner/jiti";
import * as piAiModule from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as piCodingAgentModule from "@mariozechner/pi-coding-agent";
import * as typeboxModule from "@sinclair/typebox";

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
	["generate_image", "mcp__antigravity__generate_image"],
	["image_quota", "mcp__antigravity__image_quota"],
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
	{
		dirName: "pi-antigravity-image-gen",
		packageName: "@benvargas/pi-antigravity-image-gen",
		aliases: [
			["generate_image", "mcp__antigravity__generate_image"],
			["image_quota", "mcp__antigravity__image_quota"],
		],
	},
];

/** Reverse lookup: flat tool name → its companion spec. */
const TOOL_TO_COMPANION = new Map<string, CompanionSpec>(
	COMPANIONS.flatMap((spec) => spec.aliases.map(([flat]) => [flat, spec] as const)),
);

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
	return text.replaceAll("pi itself", "the cli itself");
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

function filterAndRemapTools(tools: unknown[] | undefined, disableFilter: boolean): unknown[] | undefined {
	if (!Array.isArray(tools)) return tools;

	const advertised = collectToolNames(tools);
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
				// Alias exists in tool list → rename flat to alias, dedup
				emitted.add(aliasLc);
				result.push({ ...tool, name: mcpAlias });
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
				"@mariozechner/pi-ai": piAiModule,
				"@mariozechner/pi-coding-agent": piCodingAgentModule,
				"@sinclair/typebox": typeboxModule,
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

async function registerAliasesForLoadedCompanions(pi: ExtensionAPI): Promise<void> {
	// Clear capture cache so flag/config changes since last call take effect
	captureCache.clear();

	const allTools = pi.getAllTools();
	const toolIndex = new Map<string, ToolInfo>();
	const knownNames = new Set<string>();
	for (const tool of allTools) {
		toolIndex.set(lower(tool.name), tool);
		knownNames.add(lower(tool.name));
	}

	for (const spec of COMPANIONS) {
		for (const [flatName, mcpName] of spec.aliases) {
			if (registeredMcpAliases.has(mcpName) || knownNames.has(lower(mcpName))) continue;

			const tool = toolIndex.get(lower(flatName));
			if (!tool || !isCompanionSource(tool, spec)) continue;

			// Prefer the extension file's directory for loading (sourceInfo.path is the actual
			// entry point). Fall back to baseDir only if path is unavailable. baseDir can be
			// the monorepo root which doesn't contain the extension entry point directly.
			const loadDir = tool.sourceInfo?.path ? dirname(tool.sourceInfo.path) : tool.sourceInfo?.baseDir;
			if (!loadDir) continue;

			const captured = await captureCompanionTools(loadDir, pi);
			const def = captured.get(flatName);
			if (!def) continue;

			pi.registerTool({
				...def,
				name: mcpName,
				label: def.label?.startsWith("MCP ") ? def.label : `MCP ${def.label ?? mcpName}`,
			});
			registeredMcpAliases.add(mcpName);
			knownNames.add(lower(mcpName));
		}
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
		await registerAliasesForLoadedCompanions(pi);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await registerAliasesForLoadedCompanions(pi);
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
	filterAndRemapTools,
	getLastManagedToolList: () => lastManagedToolList,
	isCompanionSource,
	isPlainObject,
	lower,
	registerAliasesForLoadedCompanions,
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
