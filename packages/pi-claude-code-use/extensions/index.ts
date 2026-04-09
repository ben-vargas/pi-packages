import { appendFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createJiti } from "@mariozechner/jiti";
import * as bundledPiAi from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as bundledPiCodingAgent from "@mariozechner/pi-coding-agent";
import * as bundledTypebox from "@sinclair/typebox";

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
	messages?: Array<{
		role?: string;
		content?: string | unknown[];
		[key: string]: unknown;
	}>;
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

type AnthropicTransformOptions = {
	disableToolFiltering?: boolean;
};

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
type RegisteredToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
type KnownCompanionExtension = {
	baseDirName: string;
	packageName: string;
	toolAliases: Array<readonly [originalName: string, aliasName: string]>;
};

const debugLogPath = process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG;

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
		packageName: "@benvargas/pi-exa-mcp",
		toolAliases: [
			["web_search_exa", "mcp__exa__web_search"],
			["get_code_context_exa", "mcp__exa__get_code_context"],
		],
	},
	{
		baseDirName: "pi-firecrawl",
		packageName: "@benvargas/pi-firecrawl",
		toolAliases: [
			["firecrawl_scrape", "mcp__firecrawl__scrape"],
			["firecrawl_map", "mcp__firecrawl__map"],
			["firecrawl_search", "mcp__firecrawl__search"],
		],
	},
	{
		baseDirName: "pi-antigravity-image-gen",
		packageName: "@benvargas/pi-antigravity-image-gen",
		toolAliases: [
			["generate_image", "mcp__antigravity__generate_image"],
			["image_quota", "mcp__antigravity__image_quota"],
		],
	},
];

const KNOWN_COMPANION_EXTENSION_BY_TOOL_NAME = new Map<string, KnownCompanionExtension>(
	KNOWN_COMPANION_EXTENSIONS.flatMap((companionExtension) =>
		companionExtension.toolAliases.map(([originalName]) => [originalName, companionExtension] as const),
	),
);

const capturedToolDefinitionsByExtensionDir = new Map<string, Promise<Map<string, RegisteredToolDefinition>>>();
const registeredAliasNames = new Set<string>();
const autoActivatedAliasNames = new Set<string>();
let lastAutoManagedToolNames: string[] | undefined;
let extensionImportLoader:
	| {
			import(path: string, options?: { default?: boolean }): Promise<unknown>;
	  }
	| undefined;

function isToolFilteringDisabled(options?: AnthropicTransformOptions): boolean {
	return options?.disableToolFiltering ?? process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER === "1";
}

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

function rewriteAnthropicToolChoice(
	toolChoice: AnthropicPayload["tool_choice"],
	advertisedToolNames: Set<string>,
	disableFiltering: boolean,
): AnthropicPayload["tool_choice"] {
	if (toolChoice?.type !== "tool" || typeof toolChoice.name !== "string") {
		return toolChoice;
	}

	const visibleToolName = getClaudeCodeVisibleToolName(toolChoice.name, advertisedToolNames);
	if (visibleToolName) {
		return visibleToolName === toolChoice.name ? toolChoice : { ...toolChoice, name: visibleToolName };
	}
	if (disableFiltering) {
		return toolChoice;
	}
	return undefined;
}

function rewriteHistoricalToolUseBlocks(
	messages: AnthropicPayload["messages"],
	advertisedToolNames: Set<string>,
): AnthropicPayload["messages"] {
	if (!Array.isArray(messages)) {
		return messages;
	}

	return messages.map((message) => {
		if (!Array.isArray(message?.content)) {
			return message;
		}

		let changed = false;
		const content = message.content.map((block) => {
			if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") {
				return block;
			}

			const visibleToolName = getClaudeCodeVisibleToolName(block.name, advertisedToolNames);
			if (!visibleToolName || visibleToolName === block.name) {
				return block;
			}

			changed = true;
			return { ...block, name: visibleToolName };
		});

		return changed ? { ...message, content } : message;
	});
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

function filterToolsForClaudeCode(payload: AnthropicPayload, options?: AnthropicTransformOptions): AnthropicPayload {
	const disableFiltering = isToolFilteringDisabled(options);
	const advertisedToolNames = getAdvertisedToolNames(payload.tools);
	let tools = payload.tools;

	if (Array.isArray(payload.tools)) {
		const seenToolNames = new Set<string>();
		tools = payload.tools.flatMap((tool) => {
			if (typeof tool?.type === "string" && tool.type.trim().length > 0) {
				return [tool];
			}

			const originalName = typeof tool?.name === "string" ? tool.name : undefined;
			const visibleName = getClaudeCodeVisibleToolName(originalName, advertisedToolNames);
			const nextName = visibleName ?? (disableFiltering ? originalName : undefined);
			const normalizedNextName = normalizeToolName(nextName);
			if (!nextName || seenToolNames.has(normalizedNextName)) {
				return [];
			}

			seenToolNames.add(normalizedNextName);
			return [nextName === originalName ? tool : { ...tool, name: nextName }];
		});
	}

	const rewrittenToolChoice = rewriteAnthropicToolChoice(
		payload.tool_choice,
		getAdvertisedToolNames(tools),
		disableFiltering,
	);

	return {
		...payload,
		...(tools ? { tools } : {}),
		...(rewrittenToolChoice ? { tool_choice: rewrittenToolChoice } : {}),
		...(rewrittenToolChoice ? {} : { tool_choice: undefined }),
	};
}

function transformAnthropicOAuthPayload(
	payload: AnthropicPayload,
	options?: AnthropicTransformOptions,
): AnthropicPayload {
	const nextPayload = filterToolsForClaudeCode(clonePayload(payload), options);
	if (nextPayload.system !== undefined) {
		nextPayload.system = rewriteSystemBlocks(nextPayload.system);
	}
	if (nextPayload.messages !== undefined) {
		nextPayload.messages = rewriteHistoricalToolUseBlocks(
			nextPayload.messages,
			getAdvertisedToolNames(nextPayload.tools),
		);
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
	const normalizedBaseDir = baseDir.replace(/\/$/, "");
	const candidates = [
		`${normalizedBaseDir}/index.ts`,
		`${normalizedBaseDir}/index.js`,
		`${normalizedBaseDir}/extensions/index.ts`,
		`${normalizedBaseDir}/extensions/index.js`,
	];

	if (!extensionImportLoader) {
		extensionImportLoader = createJiti(import.meta.url, {
			moduleCache: false,
			tryNative: false,
			virtualModules: {
				"@mariozechner/pi-ai": bundledPiAi,
				"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
				"@sinclair/typebox": bundledTypebox,
			},
		});
	}

	for (const candidate of candidates) {
		try {
			const factory = await extensionImportLoader.import(candidate, { default: true });
			return typeof factory === "function" ? (factory as ExtensionFactory) : undefined;
		} catch {}
	}

	return undefined;
}

function matchesCompanionExtensionSource(
	tool: ToolInfo | undefined,
	companionExtension: KnownCompanionExtension,
): boolean {
	const baseDir = tool?.sourceInfo?.baseDir;
	if (!baseDir) {
		return false;
	}

	const baseName = basename(baseDir);
	if (baseName === companionExtension.baseDirName) {
		return true;
	}

	if (baseName === "extensions" && basename(dirname(baseDir)) === companionExtension.baseDirName) {
		return true;
	}

	const packagePath = tool?.sourceInfo?.path;
	return typeof packagePath === "string" && packagePath.includes(companionExtension.packageName);
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
		const companionExtension = KNOWN_COMPANION_EXTENSION_BY_TOOL_NAME.get(originalName);
		const baseDir = originalTool?.sourceInfo?.baseDir;
		if (
			!originalTool ||
			!baseDir ||
			!companionExtension ||
			!matchesCompanionExtensionSource(originalTool, companionExtension)
		) {
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
			if (!matchesCompanionExtensionSource(originalTool, companionExtension)) {
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
	const selectionMatchesLastAutoManagedState =
		lastAutoManagedToolNames !== undefined &&
		lastAutoManagedToolNames.length === activeToolNames.length &&
		lastAutoManagedToolNames.every((toolName, index) => toolName === activeToolNames[index]);
	const activeAliasToolNames = activeToolNames.filter(
		(toolName) => registeredAliasNames.has(toolName) && allToolNames.has(toolName),
	);
	const preservedUserAliasToolNames = activeAliasToolNames.filter(
		(toolName) => !autoActivatedAliasNames.has(toolName) || !selectionMatchesLastAutoManagedState,
	);
	const aliasesForActiveTools = Array.from(KNOWN_MONOREPO_TOOL_ALIASES.entries())
		.filter(([originalName, aliasName]) => activeOriginalToolNames.has(originalName) && allToolNames.has(aliasName))
		.map(([, aliasName]) => aliasName);
	const nextToolNames = enableAliases
		? Array.from(
				new Set([
					...activeToolNames.filter((toolName) => !registeredAliasNames.has(toolName)),
					...preservedUserAliasToolNames,
					...aliasesForActiveTools,
				]),
			)
		: activeToolNames.filter((toolName) => !registeredAliasNames.has(toolName));

	autoActivatedAliasNames.clear();
	if (enableAliases) {
		for (const aliasName of aliasesForActiveTools) {
			if (!preservedUserAliasToolNames.includes(aliasName)) {
				autoActivatedAliasNames.add(aliasName);
			}
		}
	}

	if (
		nextToolNames.length !== activeToolNames.length ||
		nextToolNames.some((toolName, index) => toolName !== activeToolNames[index])
	) {
		pi.setActiveTools(nextToolNames);
		lastAutoManagedToolNames = [...nextToolNames];
	} else if (!enableAliases) {
		lastAutoManagedToolNames = undefined;
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
	matchesCompanionExtensionSource,
	registerKnownMonorepoToolAliases,
	autoActivatedAliasNames,
	getLastAutoManagedToolNames() {
		return lastAutoManagedToolNames;
	},
	setLastAutoManagedToolNames(value: string[] | undefined) {
		lastAutoManagedToolNames = value;
	},
	registeredAliasNames,
	rewritePiSelfReferences,
	syncKnownAliasToolActivation,
	transformAnthropicOAuthPayload,
};
