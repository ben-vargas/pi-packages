import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";

const require = createRequire(import.meta.url);

type XXHashDigest = {
	toString(radix?: number): string;
};

type XXHashState = {
	update(data: string | ArrayBuffer | Buffer): XXHashState;
	digest(): XXHashDigest;
};

type XXHashModule = {
	h64(seed?: unknown): XXHashState;
};

type CUIntModule = {
	UINT64(seed: string | number): unknown;
};

const { h64 } = require("xxhashjs") as XXHashModule;
const { UINT64 } = require("cuint") as CUIntModule;
const anthropicProviderModuleUrl = new URL("./providers/anthropic.js", await import.meta.resolve("@mariozechner/pi-ai"))
	.href;
const simpleOptionsModuleUrl = new URL(
	"./providers/simple-options.js",
	await import.meta.resolve("@mariozechner/pi-ai"),
).href;
const piAiRequire = createRequire(anthropicProviderModuleUrl);

type AnthropicClient = {
	[key: string]: unknown;
};

type AnthropicClientConstructor = new (options: Record<string, unknown>) => AnthropicClient;

const { default: AnthropicClientSdk } = piAiRequire("@anthropic-ai/sdk") as {
	default: AnthropicClientConstructor;
};
const { streamAnthropic, streamSimpleAnthropic } = (await import(anthropicProviderModuleUrl)) as {
	streamAnthropic: (
		model: Model<"anthropic-messages">,
		context: Context,
		options?: Record<string, unknown>,
	) => AssistantMessageEventStream;
	streamSimpleAnthropic: (
		model: Model<"anthropic-messages">,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
};
const { adjustMaxTokensForThinking, buildBaseOptions } = (await import(simpleOptionsModuleUrl)) as {
	adjustMaxTokensForThinking: (
		baseMaxTokens: number,
		modelMaxTokens: number,
		reasoningLevel: NonNullable<SimpleStreamOptions["reasoning"]>,
		customBudgets?: SimpleStreamOptions["thinkingBudgets"],
	) => { maxTokens: number; thinkingBudget: number };
	buildBaseOptions: (model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string) => Record<string, unknown>;
};

const CLAUDE_CODE_AGENT_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_VERSION = "2.1.77";
const STAINLESS_PACKAGE_VERSION = "0.87.0";
const STAINLESS_RUNTIME_VERSION = "v24.8.0";
const FINGERPRINT_SALT = "59cf53e54c78";
const CCH_SEED = "0x6E52736AC806831E";
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CLAUDE_CODE_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"structured-outputs-2025-12-15",
	"fast-mode-2026-02-01",
	"redact-thinking-2026-02-12",
	"token-efficient-tools-2026-03-28",
];
const EXCLUDED_ANTHROPIC_BETAS = new Set(["fine-grained-tool-streaming-2025-05-14", "prompt-caching-2024-07-31"]);
const CLAUDE_TIMEOUT_SECONDS = "600";

const sessionIdsByApiKey = new Map<string, string>();
const userIdsByApiKey = new Map<string, string>();
const debugLogPath = process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG;
const disableToolFiltering = process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER === "1";

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

type MessageContentBlock = {
	type: string;
	text?: string;
	cache_control?: CacheControl;
	[key: string]: unknown;
};

type AnthropicMessage = {
	role: string;
	content: string | MessageContentBlock[];
	[key: string]: unknown;
};

type AnthropicPayload = {
	metadata?: {
		user_id?: string;
		[key: string]: unknown;
	};
	tool_choice?: {
		type?: string;
		name?: string;
		[key: string]: unknown;
	};
	tools?: Array<{
		name?: string;
		[key: string]: unknown;
	}>;
	system?: string | TextBlock[];
	messages?: AnthropicMessage[];
	[key: string]: unknown;
};

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
type RegisteredToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
type KnownCompanionExtension = {
	id: string;
	baseDirName: string;
	toolAliases: Array<readonly [originalName: string, aliasName: string]>;
};

const ALLOWED_TOOL_NAMES = new Set(
	[
		"read",
		"write",
		"edit",
		"bash",
		"grep",
		"find",
		"ls",
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
		id: "exa",
		baseDirName: "pi-exa-mcp",
		toolAliases: [
			["web_search_exa", "mcp__exa__web_search"],
			["get_code_context_exa", "mcp__exa__get_code_context"],
		],
	},
	{
		id: "firecrawl",
		baseDirName: "pi-firecrawl",
		toolAliases: [
			["firecrawl_scrape", "mcp__firecrawl__scrape"],
			["firecrawl_map", "mcp__firecrawl__map"],
			["firecrawl_search", "mcp__firecrawl__search"],
		],
	},
	{
		id: "antigravity",
		baseDirName: "pi-antigravity-image-gen",
		toolAliases: [
			["generate_image", "mcp__antigravity__generate_image"],
			["image_quota", "mcp__antigravity__image_quota"],
		],
	},
];

const capturedToolDefinitionsByExtensionDir = new Map<string, Promise<Map<string, RegisteredToolDefinition>>>();
const registeredAliasNames = new Set<string>();

function supportsAdaptiveThinking(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6")
	);
}

function mapThinkingLevelToEffort(
	level: SimpleStreamOptions["reasoning"],
	modelId: string,
): "low" | "medium" | "high" | "max" {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") ? "max" : "high";
		default:
			return "high";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is TextBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
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

function clonePayload(payload: AnthropicPayload): AnthropicPayload {
	return JSON.parse(JSON.stringify(payload)) as AnthropicPayload;
}

function getSystemBlocks(system: AnthropicPayload["system"]): TextBlock[] {
	if (typeof system === "string") {
		return system.trim().length > 0 ? [{ type: "text", text: system }] : [];
	}
	if (!Array.isArray(system)) {
		return [];
	}
	return system.filter(isTextBlock);
}

function isBillingHeaderText(text: string): boolean {
	return text.startsWith(BILLING_HEADER_PREFIX);
}

function isClaudeCodeAgentText(text: string): boolean {
	return text.trim() === CLAUDE_CODE_AGENT_TEXT;
}

function getUserSystemBlocks(system: AnthropicPayload["system"]): TextBlock[] {
	return getSystemBlocks(system).filter((block) => {
		const text = block.text.trim();
		return !isBillingHeaderText(text) && !isClaudeCodeAgentText(text);
	});
}

function getFingerprintMessageText(blocks: TextBlock[]): string {
	return blocks.find((block) => block.text.trim().length > 0)?.text ?? "";
}

function rewritePiSelfReferences(text: string): string {
	return text.replaceAll("pi itself", "the cli itself");
}

function preserveSystemPromptBlocks(system: AnthropicPayload["system"]): TextBlock[] {
	return getSystemBlocks(system).map((block) => ({
		...block,
		text: rewritePiSelfReferences(block.text),
	}));
}

function getClaudeCodeVisibleToolName(toolName: string | undefined): string | undefined {
	if (!toolName) {
		return undefined;
	}
	if (isCoreClaudeCodeToolName(toolName) || isMcpToolName(toolName)) {
		return toolName;
	}
	return getKnownAliasName(toolName);
}

function computeFingerprint(messageText: string, version: string): string {
	const chars = [4, 7, 20].map((index) => Array.from(messageText)[index] ?? "0").join("");
	return createHash("sha256").update(`${FINGERPRINT_SALT}${chars}${version}`).digest("hex").slice(0, 3);
}

function buildUnsignedBillingHeader(messageText: string, version: string): string {
	const buildHash = computeFingerprint(messageText, version);
	return `${BILLING_HEADER_PREFIX} cc_version=${version}.${buildHash}; cc_entrypoint=cli; cch=00000;`;
}

function computeCch(unsignedBody: string): string {
	const seed = UINT64(CCH_SEED);
	const hashHex = h64(seed).update(unsignedBody).digest().toString(16).padStart(16, "0");
	return (BigInt(`0x${hashHex}`) & 0xfffffn).toString(16).padStart(5, "0");
}

function signBillingHeader(payload: AnthropicPayload, version: string, messageText: string): string {
	const systemBlocks = getSystemBlocks(payload.system);
	if (systemBlocks.length === 0) {
		return JSON.stringify(payload);
	}

	const unsignedHeader = buildUnsignedBillingHeader(messageText, version);
	systemBlocks[0].text = unsignedHeader;
	payload.system = systemBlocks;

	const unsignedBody = JSON.stringify(payload);
	const signedHeader = unsignedHeader.replace("cch=00000;", `cch=${computeCch(unsignedBody)};`);
	systemBlocks[0].text = signedHeader;
	payload.system = systemBlocks;
	return JSON.stringify(payload);
}

function transformAnthropicOAuthPayload(payload: AnthropicPayload): string | undefined {
	const nextPayload = clonePayload(payload);
	const userSystemBlocks = getUserSystemBlocks(nextPayload.system);

	nextPayload.system = [
		{ type: "text", text: "" },
		{ type: "text", text: CLAUDE_CODE_AGENT_TEXT },
		...preserveSystemPromptBlocks(userSystemBlocks),
	];

	return signBillingHeader(nextPayload, CLAUDE_CODE_VERSION, getFingerprintMessageText(userSystemBlocks));
}

function getClaudeCodeUserId(apiKey: string): string {
	let userId = userIdsByApiKey.get(apiKey);
	if (!userId) {
		const userHash = createHash("sha256").update(apiKey).digest("hex");
		userId = `user_${userHash}_account_${randomUUID()}_session_${randomUUID()}`;
		userIdsByApiKey.set(apiKey, userId);
	}
	return userId;
}

function ensureClaudeCodeMetadata(payload: AnthropicPayload, apiKey: string): AnthropicPayload {
	if (payload.metadata?.user_id) {
		return payload;
	}
	return {
		...payload,
		metadata: {
			...payload.metadata,
			user_id: getClaudeCodeUserId(apiKey),
		},
	};
}

function filterToolsForClaudeCode(payload: AnthropicPayload): AnthropicPayload {
	if (disableToolFiltering || !Array.isArray(payload.tools)) {
		return payload;
	}

	const seenToolNames = new Set<string>();
	const tools = payload.tools.flatMap((tool) => {
		if (typeof tool?.type === "string" && tool.type.trim().length > 0) {
			return [tool];
		}
		const visibleName = getClaudeCodeVisibleToolName(typeof tool?.name === "string" ? tool.name : undefined);
		const normalizedVisibleName = normalizeToolName(visibleName);
		if (!visibleName || seenToolNames.has(normalizedVisibleName)) {
			return [];
		}
		seenToolNames.add(normalizedVisibleName);
		return [{ ...tool, name: visibleName }];
	});

	let toolChoice = payload.tool_choice;
	if (toolChoice?.type === "tool" && typeof toolChoice.name === "string") {
		const visibleToolName = getClaudeCodeVisibleToolName(toolChoice.name);
		toolChoice = visibleToolName ? { ...toolChoice, name: visibleToolName } : undefined;
	}

	return {
		...payload,
		tools,
		...(toolChoice ? { tool_choice: toolChoice } : {}),
		...(toolChoice ? {} : { tool_choice: undefined }),
	};
}

async function importExtensionFactoryFromDir(baseDir: string): Promise<ExtensionFactory | undefined> {
	const candidates = [
		new URL("./index.ts", pathToFileURL(`${baseDir.replace(/\/$/, "")}/`)).href,
		new URL("./index.js", pathToFileURL(`${baseDir.replace(/\/$/, "")}/`)).href,
	];

	for (const candidate of candidates) {
		try {
			const module = (await import(candidate)) as { default?: unknown };
			return typeof module.default === "function" ? (module.default as ExtensionFactory) : undefined;
		} catch {}
	}

	return undefined;
}

function getKnownCompanionExtensionCandidateDirs(baseDirName: string): string[] {
	const candidateDirs = [
		new URL(`../../${baseDirName}/extensions/`, import.meta.url).pathname,
		`${getAgentDir()}/git/github.com/ben-vargas/pi-packages/packages/${baseDirName}/extensions`,
	];

	return candidateDirs.filter(
		(candidateDir, index) => existsSync(candidateDir) && candidateDirs.indexOf(candidateDir) === index,
	);
}

function createCapturePi(realPi: ExtensionAPI, capturedTools: Map<string, RegisteredToolDefinition>): ExtensionAPI {
	return {
		on() {},
		registerTool(tool) {
			capturedTools.set(tool.name, tool as unknown as RegisteredToolDefinition);
		},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag(name) {
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
	for (const companionExtension of KNOWN_COMPANION_EXTENSIONS) {
		if (companionExtension.toolAliases.every(([, aliasName]) => registeredAliasNames.has(aliasName))) {
			continue;
		}

		let capturedTools = new Map<string, RegisteredToolDefinition>();
		for (const candidateDir of getKnownCompanionExtensionCandidateDirs(companionExtension.baseDirName)) {
			capturedTools = await captureToolDefinitionsFromDir(candidateDir, pi);
			if (capturedTools.size > 0) {
				break;
			}
		}

		if (capturedTools.size === 0) {
			continue;
		}

		for (const [originalName, aliasName] of companionExtension.toolAliases) {
			if (registeredAliasNames.has(aliasName)) {
				continue;
			}
			const definition = capturedTools.get(originalName);
			if (!definition) {
				continue;
			}
			pi.registerTool(cloneAliasedToolDefinition(definition, aliasName));
			registeredAliasNames.add(aliasName);
		}
	}
}

function syncKnownAliasToolActivation(pi: ExtensionAPI, enableAliases: boolean): void {
	const activeToolNames = pi.getActiveTools();
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const knownAliasNames = Array.from(KNOWN_MONOREPO_TOOL_ALIASES.values()).filter((aliasName) =>
		allToolNames.has(aliasName),
	);
	const activeOriginalToolNames = new Set(activeToolNames.map(normalizeToolName));
	const aliasesForActiveTools = Array.from(KNOWN_MONOREPO_TOOL_ALIASES.entries())
		.filter(([originalName, aliasName]) => activeOriginalToolNames.has(originalName) && allToolNames.has(aliasName))
		.map(([, aliasName]) => aliasName);
	const nextToolNames = enableAliases
		? Array.from(new Set([...activeToolNames, ...aliasesForActiveTools]))
		: activeToolNames.filter((toolName) => !knownAliasNames.includes(toolName));

	if (
		nextToolNames.length !== activeToolNames.length ||
		nextToolNames.some((toolName, index) => toolName !== activeToolNames[index])
	) {
		pi.setActiveTools(nextToolNames);
	}
}

function mapStainlessOs(): string {
	switch (process.platform) {
		case "darwin":
			return "MacOS";
		case "win32":
			return "Windows";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		default:
			return `Other::${process.platform}`;
	}
}

function mapStainlessArch(): string {
	switch (process.arch) {
		case "x64":
			return "x64";
		case "arm64":
			return "arm64";
		case "ia32":
			return "x86";
		default:
			return `other::${process.arch}`;
	}
}

function getClaudeCodeSessionId(apiKey: string): string {
	let sessionId = sessionIdsByApiKey.get(apiKey);
	if (!sessionId) {
		sessionId = randomUUID();
		sessionIdsByApiKey.set(apiKey, sessionId);
	}
	return sessionId;
}

function mergeAnthropicBetas(existingValue: string | null): string {
	const seen = new Set<string>();
	const merged: string[] = [];

	for (const beta of existingValue?.split(",") ?? []) {
		const trimmed = beta.trim();
		if (!trimmed || EXCLUDED_ANTHROPIC_BETAS.has(trimmed) || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		merged.push(trimmed);
	}

	for (const beta of CLAUDE_CODE_BETAS) {
		if (seen.has(beta)) {
			continue;
		}
		seen.add(beta);
		merged.push(beta);
	}

	return merged.join(",");
}

function applyClaudeCodeHeaders(headers: Headers, apiKey: string, url: string): void {
	headers.set("anthropic-beta", mergeAnthropicBetas(headers.get("anthropic-beta")));
	headers.set("authorization", `Bearer ${apiKey}`);
	headers.set("anthropic-version", "2023-06-01");
	headers.set("content-type", "application/json");
	headers.set("user-agent", `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`);
	headers.set("x-app", "cli");
	headers.set("x-stainless-package-version", STAINLESS_PACKAGE_VERSION);
	headers.set("x-stainless-runtime-version", STAINLESS_RUNTIME_VERSION);
	headers.set("x-stainless-retry-count", "0");
	headers.set("x-stainless-runtime", "node");
	headers.set("x-stainless-lang", "js");
	headers.set("x-stainless-os", mapStainlessOs());
	headers.set("x-stainless-arch", mapStainlessArch());
	headers.set("x-stainless-timeout", CLAUDE_TIMEOUT_SECONDS);
	headers.set("x-claude-code-session-id", getClaudeCodeSessionId(apiKey));
	headers.set("connection", "keep-alive");
	headers.delete("x-api-key");
	headers.delete("anthropic-dangerous-direct-browser-access");
	headers.delete("x-stainless-helper-method");
	headers.delete("x-stainless-helper");

	const accept = headers.get("accept");
	if (!accept) {
		headers.set("accept", "application/json");
	}
	if (accept?.includes("text/event-stream")) {
		headers.set("accept-encoding", "identity");
	} else if (!headers.has("accept-encoding")) {
		headers.set("accept-encoding", "gzip, deflate, br, zstd");
	}

	if (url.startsWith("https://api.anthropic.com/")) {
		headers.set("x-client-request-id", randomUUID());
	}
}

function bodyToString(body: BodyInit | null | undefined): string | undefined {
	if (typeof body === "string") {
		return body;
	}
	if (body instanceof Uint8Array) {
		return Buffer.from(body).toString("utf-8");
	}
	if (body instanceof ArrayBuffer) {
		return Buffer.from(body).toString("utf-8");
	}
	return undefined;
}

function patchSerializedAnthropicMessagesRequest(serializedBody: string, apiKey: string): string | undefined {
	try {
		const parsed = JSON.parse(serializedBody) as unknown;
		if (!isRecord(parsed)) {
			return undefined;
		}
		return transformAnthropicOAuthPayload(
			filterToolsForClaudeCode(ensureClaudeCodeMetadata(parsed as AnthropicPayload, apiKey)),
		);
	} catch {
		return undefined;
	}
}

function ensureBetaQuery(urlString: string): string {
	const url = new URL(urlString);
	if (url.pathname === "/v1/messages" && url.searchParams.get("beta") !== "true") {
		url.searchParams.set("beta", "true");
	}
	return url.toString();
}

function debugLogOutboundRequest(url: string, headers: Headers, body: string | undefined): void {
	if (!debugLogPath) {
		return;
	}

	const headerEntries: Array<[string, string]> = [];
	headers.forEach((value, key) => {
		headerEntries.push([key, value]);
	});
	headerEntries.sort(([a], [b]) => a.localeCompare(b));
	appendFileSync(
		debugLogPath,
		`${new Date().toISOString()}\nURL: ${url}\nHeaders: ${JSON.stringify(Object.fromEntries(headerEntries), null, 2)}\nBody: ${
			body ?? "<none>"
		}\n---\n`,
		"utf8",
	);
}

function mergeClientHeaders(...headerSources: Array<Record<string, string> | undefined>): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const headers of headerSources) {
		if (!headers) {
			continue;
		}
		Object.assign(merged, headers);
	}
	return merged;
}

function createClaudeCodeFetch(apiKey: string, originalFetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => {
		const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const url = rawUrl.includes("/v1/messages") ? ensureBetaQuery(rawUrl) : rawUrl;
		const nextInit: RequestInit = { ...init };
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, key) => {
			headers.set(key, value);
		});

		if (url.includes("/v1/messages")) {
			applyClaudeCodeHeaders(headers, apiKey, url);
			const originalBody =
				init?.body ??
				(input instanceof Request && !input.bodyUsed && input.method.toUpperCase() !== "GET"
					? await input.clone().text()
					: undefined);
			const body = bodyToString(originalBody);
			const patchedBody = body ? patchSerializedAnthropicMessagesRequest(body, apiKey) : undefined;
			if (patchedBody) {
				nextInit.body = patchedBody;
			}

			debugLogOutboundRequest(url, headers, typeof nextInit.body === "string" ? nextInit.body : body);
		}

		nextInit.headers = headers;
		if (input instanceof Request) {
			return originalFetch(new Request(url, input), nextInit);
		}
		return originalFetch(url, nextInit);
	};
}

function createClaudeCodeAwareClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	fetch: typeof globalThis.fetch,
	options?: SimpleStreamOptions,
): AnthropicClient {
	return new AnthropicClientSdk({
		apiKey: null,
		authToken: apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: mergeClientHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
			},
			model.headers as Record<string, string> | undefined,
			options?.headers,
		),
	});
}

function streamSimpleAnthropicClaudeCodeAware(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey;
	const anthropicModel = model as Model<"anthropic-messages">;
	if (apiKey === undefined || model.provider !== "anthropic" || !isAnthropicSubscriptionAuthKey(apiKey)) {
		return streamSimpleAnthropic(anthropicModel, context, options);
	}

	const originalFetch = globalThis.fetch.bind(globalThis);
	const wrappedFetch = createClaudeCodeFetch(apiKey, originalFetch);
	const client = createClaudeCodeAwareClient(anthropicModel, apiKey, wrappedFetch, options);
	const base = buildBaseOptions(anthropicModel, options, apiKey);

	if (!options?.reasoning) {
		return streamAnthropic(anthropicModel, context, {
			...base,
			client,
			thinkingEnabled: false,
		});
	}

	if (supportsAdaptiveThinking(anthropicModel.id)) {
		return streamAnthropic(anthropicModel, context, {
			...base,
			client,
			thinkingEnabled: true,
			effort: mapThinkingLevelToEffort(options.reasoning, anthropicModel.id),
		});
	}

	const adjusted = adjustMaxTokensForThinking(
		typeof base.maxTokens === "number" ? base.maxTokens : 0,
		anthropicModel.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);
	return streamAnthropic(anthropicModel, context, {
		...base,
		client,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	});
}

export default async function piClaudeCodeUse(pi: ExtensionAPI): Promise<void> {
	await eagerRegisterKnownCompanionAliases(pi);

	pi.on("session_start", async () => {
		await registerKnownMonorepoToolAliases(pi);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await registerKnownMonorepoToolAliases(pi);
		const model = ctx.model;
		const enableAliases =
			model?.provider === "anthropic" && model !== undefined && ctx.modelRegistry.isUsingOAuth(model);
		syncKnownAliasToolActivation(pi, enableAliases);
	});

	pi.registerProvider("anthropic", {
		api: "anthropic-messages",
		streamSimple: streamSimpleAnthropicClaudeCodeAware,
	});
}

export const _test = {
	CLAUDE_CODE_VERSION,
	STAINLESS_PACKAGE_VERSION,
	STAINLESS_RUNTIME_VERSION,
	CLAUDE_CODE_AGENT_TEXT,
	applyClaudeCodeHeaders,
	buildUnsignedBillingHeader,
	computeCch,
	computeFingerprint,
	createClaudeCodeFetch,
	getUserSystemBlocks,
	isAnthropicSubscriptionAuthKey,
	getClaudeCodeVisibleToolName,
	getKnownAliasName,
	isCoreClaudeCodeToolName,
	isMcpToolName,
	eagerRegisterKnownCompanionAliases,
	patchSerializedAnthropicMessagesRequest,
	syncKnownAliasToolActivation,
	registerKnownMonorepoToolAliases,
	rewritePiSelfReferences,
	streamSimpleAnthropicClaudeCodeAware,
	transformAnthropicOAuthPayload,
};
