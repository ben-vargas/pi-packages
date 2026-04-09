import { appendFileSync } from "node:fs";
import { createJiti } from "@mariozechner/jiti";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CacheControl = {
	type: "ephemeral";
	ttl?: "1h";
};

type TextBlock = {
	type: "text";
	text: string;
	cache_control?: CacheControl;
	[key: string]: unknown;
};

type AnthropicPayload = {
	tool_choice?: {
		type?: string;
		name?: string;
		[key: string]: unknown;
	};
	tools?: Array<{
		type?: string;
		name?: string;
		[key: string]: unknown;
	}>;
	system?: string | unknown[];
	[key: string]: unknown;
};

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
type RegisteredToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
type KnownCompanionExtension = {
	baseDirName: string;
	toolAliases: Array<readonly [originalName: string, aliasName: string]>;
};

const debugLogPath = process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG;
const disableToolFiltering = process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER === "1";

// Mirror Pi core's Anthropic Claude Code tool set from:
// packages/ai/src/providers/anthropic.ts -> claudeCodeTools
const ALLOWED_TOOL_NAMES = new Set(
	[
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
	].map((name) => name.toLowerCase()),
);

const KNOWN_MONOREPO_TOOL_ALIASES = new Map<string, string>([
	["web_search_exa", "mcp__exa__web_search"],
	["get_code_context_exa", "mcp__exa__get_code_context"],
	["firecrawl_scrape", "mcp__firecrawl__scrape"],
	["firecrawl_map", "mcp__firecrawl__map"],
	["firecrawl_search", "mcp__firecrawl__search"],
	["generate_image", "mcp__antigravity__generate_image"],
	["image_quota", "mcp__antigravity__image_quota"],
]);

const KNOWN_COMPANION_EXTENSIONS: KnownCompanionExtension[] = [
	{
		baseDirName: "pi-exa-mcp",
		toolAliases: [
			["web_search_exa", "mcp__exa__web_search"],
			["get_code_context_exa", "mcp__exa__get_code_context"],
		],
	},
	{
		baseDirName: "pi-firecrawl",
		toolAliases: [
			["firecrawl_scrape", "mcp__firecrawl__scrape"],
			["firecrawl_map", "mcp__firecrawl__map"],
			["firecrawl_search", "mcp__firecrawl__search"],
		],
	},
	{
		baseDirName: "pi-antigravity-image-gen",
		toolAliases: [
			["generate_image", "mcp__antigravity__generate_image"],
			["image_quota", "mcp__antigravity__image_quota"],
		],
	},
];

const capturedToolDefinitionsByExtensionDir = new Map<string, Promise<Map<string, RegisteredToolDefinition>>>();
const registeredAliasNames = new Set<string>();
let extensionImportLoader:
	| {
			import(path: string, options?: { default?: boolean }): Promise<unknown>;
	  }
	| undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is TextBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function normalizeToolName(name: string | undefined): string {
	return (name ?? "").trim().toLowerCase();
}

function isCoreClaudeCodeToolName(name: string | undefined): boolean {
	return ALLOWED_TOOL_NAMES.has(normalizeToolName(name));
}

function isMcpToolName(name: string | undefined): boolean {
	return normalizeToolName(name).startsWith("mcp__");
}

function getKnownAliasName(toolName: string | undefined): string | undefined {
	return KNOWN_MONOREPO_TOOL_ALIASES.get(normalizeToolName(toolName));
}

function getAdvertisedToolNames(tools: AnthropicPayload["tools"]): Set<string> {
	if (!Array.isArray(tools)) {
		return new Set<string>();
	}
	return new Set(
		tools
			.map((tool) => (typeof tool?.name === "string" ? normalizeToolName(tool.name) : ""))
			.filter((name) => name.length > 0),
	);
}

function clonePayload(payload: AnthropicPayload): AnthropicPayload {
	return JSON.parse(JSON.stringify(payload)) as AnthropicPayload;
}

function rewritePiSelfReferences(text: string): string {
	return text.replaceAll("pi itself", "the cli itself");
}

function rewriteSystemBlocks(system: AnthropicPayload["system"]): AnthropicPayload["system"] {
	if (typeof system === "string") {
		return rewritePiSelfReferences(system);
	}
	if (!Array.isArray(system)) {
		return system;
	}
	return system.map((block) => {
		if (!isTextBlock(block)) {
			return block;
		}
		return {
			...block,
			text: rewritePiSelfReferences(block.text),
		};
	});
}

function getClaudeCodeVisibleToolName(
	toolName: string | undefined,
	advertisedToolNames?: Set<string>,
): string | undefined {
	if (!toolName) {
		return undefined;
	}
	if (isCoreClaudeCodeToolName(toolName) || isMcpToolName(toolName)) {
		return toolName;
	}
	const aliasName = getKnownAliasName(toolName);
	if (!aliasName) {
		return undefined;
	}
	if (advertisedToolNames && !advertisedToolNames.has(normalizeToolName(aliasName))) {
		return undefined;
	}
	return aliasName;
}

function filterToolsForClaudeCode(payload: AnthropicPayload): AnthropicPayload {
	if (disableToolFiltering || !Array.isArray(payload.tools)) {
		return payload;
	}

	const advertisedToolNames = getAdvertisedToolNames(payload.tools);
	const seenToolNames = new Set<string>();
	const tools = payload.tools.flatMap((tool) => {
		if (typeof tool?.type === "string" && tool.type.trim().length > 0) {
			return [tool];
		}

		const visibleName = getClaudeCodeVisibleToolName(
			typeof tool?.name === "string" ? tool.name : undefined,
			advertisedToolNames,
		);
		const normalizedVisibleName = normalizeToolName(visibleName);
		if (!visibleName || seenToolNames.has(normalizedVisibleName)) {
			return [];
		}

		seenToolNames.add(normalizedVisibleName);
		return [{ ...tool, name: visibleName }];
	});

	let toolChoice = payload.tool_choice;
	if (toolChoice?.type === "tool" && typeof toolChoice.name === "string") {
		const visibleToolName = getClaudeCodeVisibleToolName(toolChoice.name, advertisedToolNames);
		toolChoice = visibleToolName ? { ...toolChoice, name: visibleToolName } : undefined;
	}

	return {
		...payload,
		tools,
		...(toolChoice ? { tool_choice: toolChoice } : {}),
		...(toolChoice ? {} : { tool_choice: undefined }),
	};
}

function transformAnthropicOAuthPayload(payload: AnthropicPayload): AnthropicPayload {
	const nextPayload = filterToolsForClaudeCode(clonePayload(payload));
	if (nextPayload.system !== undefined) {
		nextPayload.system = rewriteSystemBlocks(nextPayload.system);
	}
	return nextPayload;
}

function debugLogPayload(payload: unknown): void {
	if (!debugLogPath) {
		return;
	}

	try {
		appendFileSync(debugLogPath, `${new Date().toISOString()}\n${JSON.stringify(payload, null, 2)}\n---\n`, "utf8");
	} catch {}
}

async function importExtensionFactoryFromDir(baseDir: string): Promise<ExtensionFactory | undefined> {
	const candidates = [`${baseDir.replace(/\/$/, "")}/index.ts`, `${baseDir.replace(/\/$/, "")}/index.js`];

	if (!extensionImportLoader) {
		extensionImportLoader = createJiti(import.meta.url, {
			moduleCache: false,
			alias: {
				"@mariozechner/pi-coding-agent": import.meta.resolve("@mariozechner/pi-coding-agent"),
				"@mariozechner/pi-ai": import.meta.resolve("@mariozechner/pi-ai"),
				"@mariozechner/pi-ai/oauth": import.meta.resolve("@mariozechner/pi-ai/oauth"),
				"@sinclair/typebox": import.meta.resolve("@sinclair/typebox"),
			},
		});
	}

	for (const candidate of candidates) {
		try {
			const module = (await extensionImportLoader.import(candidate, { default: true })) as { default?: unknown };
			return typeof module.default === "function" ? (module.default as ExtensionFactory) : undefined;
		} catch {}
	}

	return undefined;
}

function createCapturePi(realPi: ExtensionAPI, capturedTools: Map<string, RegisteredToolDefinition>): ExtensionAPI {
	const registeredFlags = new Set<string>();
	return {
		on() {},
		registerTool(tool) {
			capturedTools.set(tool.name, tool as unknown as RegisteredToolDefinition);
		},
		registerCommand() {},
		registerShortcut() {},
		registerFlag(name, options) {
			registeredFlags.add(name);
			realPi.registerFlag(name, options);
		},
		getFlag(name) {
			if (!registeredFlags.has(name)) {
				return undefined;
			}
			return realPi.getFlag(name);
		},
		registerMessageRenderer() {},
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
		setActiveTools(toolNames) {
			realPi.setActiveTools(toolNames);
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
		registerProvider() {},
		unregisterProvider() {},
		events: realPi.events,
	} as ExtensionAPI;
}

async function captureToolDefinitionsFromDir(
	baseDir: string,
	realPi: ExtensionAPI,
): Promise<Map<string, RegisteredToolDefinition>> {
	let capturedPromise = capturedToolDefinitionsByExtensionDir.get(baseDir);
	if (!capturedPromise) {
		capturedPromise = (async () => {
			const factory = await importExtensionFactoryFromDir(baseDir);
			if (!factory) {
				return new Map<string, RegisteredToolDefinition>();
			}

			const capturedTools = new Map<string, RegisteredToolDefinition>();
			await factory(createCapturePi(realPi, capturedTools));
			return capturedTools;
		})();
		capturedToolDefinitionsByExtensionDir.set(baseDir, capturedPromise);
	}

	return capturedPromise;
}

function cloneAliasedToolDefinition(tool: RegisteredToolDefinition, aliasName: string): RegisteredToolDefinition {
	return {
		...tool,
		name: aliasName,
		label: tool.label?.startsWith("MCP ") ? tool.label : `MCP ${tool.label ?? aliasName}`,
	};
}

async function registerKnownMonorepoToolAliases(pi: ExtensionAPI): Promise<void> {
	const toolsByName = new Map<string, ToolInfo>();
	for (const tool of pi.getAllTools()) {
		toolsByName.set(tool.name, tool);
	}

	const aliasJobs = Array.from(KNOWN_MONOREPO_TOOL_ALIASES.entries()).map(async ([originalName, aliasName]) => {
		if (registeredAliasNames.has(aliasName) || toolsByName.has(aliasName)) {
			return;
		}

		const originalTool = toolsByName.get(originalName);
		const baseDir = originalTool?.sourceInfo?.baseDir;
		if (!originalTool || !baseDir) {
			return;
		}

		const capturedTools = await captureToolDefinitionsFromDir(baseDir, pi);
		const definition = capturedTools.get(originalName);
		if (!definition) {
			return;
		}

		pi.registerTool(cloneAliasedToolDefinition(definition, aliasName));
		registeredAliasNames.add(aliasName);
	});

	await Promise.all(aliasJobs);
}

async function eagerRegisterKnownCompanionAliases(pi: ExtensionAPI): Promise<void> {
	const toolsByName = new Map<string, ToolInfo>();
	const availableToolNames = new Set<string>();
	for (const tool of pi.getAllTools()) {
		const normalizedToolName = normalizeToolName(tool.name);
		toolsByName.set(normalizedToolName, tool);
		availableToolNames.add(normalizedToolName);
	}

	for (const companionExtension of KNOWN_COMPANION_EXTENSIONS) {
		const pendingAliases = companionExtension.toolAliases.filter(([originalName, aliasName]) => {
			const normalizedAliasName = normalizeToolName(aliasName);
			const originalTool = toolsByName.get(originalName);
			if (!originalTool?.sourceInfo?.baseDir) {
				return false;
			}
			return !registeredAliasNames.has(aliasName) && !availableToolNames.has(normalizedAliasName);
		});

		if (pendingAliases.length === 0) {
			continue;
		}

		for (const [originalName, aliasName] of pendingAliases) {
			const originalTool = toolsByName.get(originalName);
			const baseDir = originalTool?.sourceInfo?.baseDir;
			if (!baseDir) {
				continue;
			}

			const capturedTools = await captureToolDefinitionsFromDir(baseDir, pi);
			const definition = capturedTools.get(originalName);
			if (!definition) {
				continue;
			}
			pi.registerTool(cloneAliasedToolDefinition(definition, aliasName));
			registeredAliasNames.add(aliasName);
			availableToolNames.add(normalizeToolName(aliasName));
		}
	}
}

function syncKnownAliasToolActivation(pi: ExtensionAPI, enableAliases: boolean): void {
	const activeToolNames = pi.getActiveTools();
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const activeOriginalToolNames = new Set(activeToolNames.map(normalizeToolName));
	const aliasesForActiveTools = Array.from(KNOWN_MONOREPO_TOOL_ALIASES.entries())
		.filter(([originalName, aliasName]) => activeOriginalToolNames.has(originalName) && allToolNames.has(aliasName))
		.map(([, aliasName]) => aliasName);
	const nextToolNames = enableAliases
		? Array.from(
				new Set([
					...activeToolNames.filter((toolName) => !registeredAliasNames.has(toolName)),
					...aliasesForActiveTools,
				]),
			)
		: activeToolNames.filter((toolName) => !registeredAliasNames.has(toolName));

	if (
		nextToolNames.length !== activeToolNames.length ||
		nextToolNames.some((toolName, index) => toolName !== activeToolNames[index])
	) {
		pi.setActiveTools(nextToolNames);
	}
}

export default async function piClaudeCodeUse(pi: ExtensionAPI): Promise<void> {
	pi.on("session_start", async () => {
		await eagerRegisterKnownCompanionAliases(pi);
		await registerKnownMonorepoToolAliases(pi);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await eagerRegisterKnownCompanionAliases(pi);
		await registerKnownMonorepoToolAliases(pi);
		const model = ctx.model;
		const enableAliases =
			model?.provider === "anthropic" && model !== undefined && ctx.modelRegistry.isUsingOAuth(model);
		syncKnownAliasToolActivation(pi, enableAliases);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(model)) {
			return undefined;
		}
		if (!isRecord(event.payload)) {
			return undefined;
		}

		const transformedPayload = transformAnthropicOAuthPayload(event.payload as AnthropicPayload);
		debugLogPayload(transformedPayload);
		return transformedPayload;
	});
}

export const _test = {
	createCapturePi,
	filterToolsForClaudeCode,
	getClaudeCodeVisibleToolName,
	getAdvertisedToolNames,
	getKnownAliasName,
	isCoreClaudeCodeToolName,
	isMcpToolName,
	registerKnownMonorepoToolAliases,
	registeredAliasNames,
	rewritePiSelfReferences,
	syncKnownAliasToolActivation,
	transformAnthropicOAuthPayload,
};
