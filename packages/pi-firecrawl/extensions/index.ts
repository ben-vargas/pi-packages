import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT_MS = 30000;
const CONFIG_FILENAME = "firecrawl.json";
const DEFAULT_CONFIG_FILE: Record<string, unknown> = {
	url: DEFAULT_BASE_URL,
	apiKey: null,
	headers: null,
	tools: ["firecrawl_scrape", "firecrawl_map", "firecrawl_search"],
	timeoutMs: DEFAULT_TIMEOUT_MS,
	maxBytes: DEFAULT_MAX_BYTES,
	maxLines: DEFAULT_MAX_LINES,
};

interface FirecrawlConfig {
	url?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	tools?: string[];
	maxBytes?: number;
	maxLines?: number;
}

interface FirecrawlRequestConfig {
	baseUrl: string;
	headers: Record<string, string>;
	timeoutMs: number;
	apiKey?: string;
	tools?: string[];
	maxBytes?: number;
	maxLines?: number;
}

interface FirecrawlResponse {
	success: boolean;
	data?: unknown;
	links?: unknown[];
	error?: string;
	[key: string]: unknown;
}

interface ToolOutputDetails {
	tool: string;
	baseUrl: string;
	truncated: boolean;
	truncation?: {
		truncatedBy: "lines" | "bytes" | null;
		totalLines: number;
		totalBytes: number;
		outputLines: number;
		outputBytes: number;
		maxLines: number;
		maxBytes: number;
	};
	tempFile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonString(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function writeTempFile(toolName: string, content: string): string {
	const safeName = toolName.replace(/[^a-z0-9_-]/gi, "_");
	const filename = `pi-firecrawl-${safeName}-${Date.now()}.txt`;
	const filePath = join(tmpdir(), filename);
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const headers: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		if (typeof rawValue === "string") headers[key] = rawValue;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeTools(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const tools = value
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		return tools.length > 0 ? tools : undefined;
	}
	if (Array.isArray(value)) {
		const tools = value.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0);
		return tools.length > 0 ? tools : undefined;
	}
	return undefined;
}

function parseTimeoutMs(value: string | number | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function redactUrl(url: string, apiKey?: string): string {
	let safe = url;
	if (apiKey) safe = safe.replaceAll(apiKey, "REDACTED");
	safe = safe.replace(/:\/\/([^@/]+)@/, "://REDACTED@");
	return safe;
}

function splitParams(params: Record<string, unknown>): {
	apiArgs: Record<string, unknown>;
	requestedLimits: { maxBytes?: number; maxLines?: number };
} {
	const { piMaxBytes, piMaxLines, ...rest } = params as Record<string, unknown> & {
		piMaxBytes?: unknown;
		piMaxLines?: unknown;
	};
	return {
		apiArgs: rest,
		requestedLimits: {
			maxBytes: normalizeNumber(piMaxBytes),
			maxLines: normalizeNumber(piMaxLines),
		},
	};
}

function resolveMaxLimits(config: FirecrawlRequestConfig): { maxBytes: number; maxLines: number } {
	return {
		maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: config.maxLines ?? DEFAULT_MAX_LINES,
	};
}

function resolveEffectiveLimits(
	requested: { maxBytes?: number; maxLines?: number },
	maxAllowed: { maxBytes: number; maxLines: number },
): { maxBytes: number; maxLines: number } {
	return {
		maxBytes: Math.min(requested.maxBytes ?? maxAllowed.maxBytes, maxAllowed.maxBytes),
		maxLines: Math.min(requested.maxLines ?? maxAllowed.maxLines, maxAllowed.maxLines),
	};
}

function formatToolOutput(
	toolName: string,
	baseUrl: string,
	responseText: string,
	limits: { maxBytes: number; maxLines: number },
): { text: string; details: ToolOutputDetails } {
	const truncation = truncateHead(responseText, {
		maxLines: limits.maxLines,
		maxBytes: limits.maxBytes,
	});

	let text = truncation.content;
	let tempFile: string | undefined;

	if (truncation.truncated) {
		tempFile = writeTempFile(toolName, responseText);
		text +=
			`\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
			`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
			`Full output saved to: ${tempFile}]`;
	}

	if (truncation.firstLineExceedsLimit && responseText.length > 0) {
		text =
			`[First line exceeded ${formatSize(truncation.maxBytes)} limit. Full output saved to: ${tempFile ?? "N/A"}]\n` +
			text;
	}

	return {
		text,
		details: {
			tool: toolName,
			baseUrl,
			truncated: truncation.truncated,
			truncation: {
				truncatedBy: truncation.truncatedBy,
				totalLines: truncation.totalLines,
				totalBytes: truncation.totalBytes,
				outputLines: truncation.outputLines,
				outputBytes: truncation.outputBytes,
				maxLines: truncation.maxLines,
				maxBytes: truncation.maxBytes,
			},
			tempFile,
		},
	};
}

function resolveConfigPath(configPath: string): string {
	const trimmed = configPath.trim();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	if (isAbsolute(trimmed)) return trimmed;
	return resolve(process.cwd(), trimmed);
}

function parseConfig(raw: unknown, pathHint: string): FirecrawlConfig {
	if (!isRecord(raw)) {
		throw new Error(`Invalid Firecrawl config at ${pathHint}: expected an object.`);
	}
	return {
		url: normalizeString(raw.url),
		apiKey: normalizeString(raw.apiKey),
		headers: normalizeHeaders(raw.headers),
		timeoutMs: normalizeNumber(raw.timeoutMs),
		tools: normalizeTools(raw.tools),
		maxBytes: normalizeNumber(raw.maxBytes),
		maxLines: normalizeNumber(raw.maxLines),
	};
}

function ensureDefaultConfigFile(projectConfigPath: string, globalConfigPath: string): void {
	if (existsSync(projectConfigPath) || existsSync(globalConfigPath)) return;
	try {
		mkdirSync(dirname(globalConfigPath), { recursive: true });
		writeFileSync(globalConfigPath, `${JSON.stringify(DEFAULT_CONFIG_FILE, null, 2)}\n`, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-firecrawl] Failed to write ${globalConfigPath}: ${message}`);
	}
}

function loadConfig(configPath: string | undefined): FirecrawlConfig | null {
	const candidates: string[] = [];
	const envConfig = process.env.FIRECRAWL_CONFIG;
	if (configPath) {
		candidates.push(resolveConfigPath(configPath));
	} else if (envConfig) {
		candidates.push(resolveConfigPath(envConfig));
	} else {
		const projectConfigPath = join(process.cwd(), ".pi", "extensions", CONFIG_FILENAME);
		const globalConfigPath = join(homedir(), ".pi", "agent", "extensions", CONFIG_FILENAME);
		ensureDefaultConfigFile(projectConfigPath, globalConfigPath);
		candidates.push(projectConfigPath, globalConfigPath);
	}

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const raw = readFileSync(candidate, "utf-8");
		try {
			return parseConfig(JSON.parse(raw), candidate);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Invalid Firecrawl config at ${candidate}: ${message}`);
		}
	}

	return null;
}

async function firecrawlFetch(
	config: FirecrawlRequestConfig,
	path: string,
	body: Record<string, unknown> | undefined,
	signal?: AbortSignal,
): Promise<FirecrawlResponse> {
	const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
	const controller = new AbortController();
	let timeoutId: NodeJS.Timeout | undefined;

	const handleParentAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) throw new Error("The operation was aborted.");
		signal.addEventListener("abort", handleParentAbort, { once: true });
	}
	if (config.timeoutMs > 0) {
		timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
	}

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				...config.headers,
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Firecrawl API ${response.status}: ${text || response.statusText}`);
		}

		const json = (await response.json()) as FirecrawlResponse;
		if (json.success === false && json.error) {
			throw new Error(json.error);
		}
		return json;
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		if (signal) signal.removeEventListener("abort", handleParentAbort);
	}
}

function formatResponse(
	toolName: "firecrawl_scrape" | "firecrawl_map" | "firecrawl_search",
	response: FirecrawlResponse,
): string {
	if (toolName === "firecrawl_map") {
		if (Array.isArray(response.links)) return response.links.join("\n");
		return toJsonString(response);
	}

	if (response.data && isRecord(response.data) && typeof response.data.markdown === "string") {
		const data = response.data as Record<string, unknown>;
		const parts: string[] = [];
		if (data.markdown) parts.push(data.markdown as string);
		if (isRecord(data.metadata)) {
			const meta = data.metadata as Record<string, unknown>;
			const metaParts: string[] = [];
			if (meta.title) metaParts.push(`Title: ${meta.title}`);
			if (meta.description) metaParts.push(`Description: ${meta.description}`);
			if (meta.url) metaParts.push(`URL: ${meta.url}`);
			if (meta.statusCode) metaParts.push(`Status: ${meta.statusCode}`);
			if (metaParts.length > 0) parts.push(`\n---\nMetadata:\n${metaParts.join("\n")}`);
		}
		return parts.join("\n");
	}

	if (response.data != null) return toJsonString(response.data);
	return toJsonString(response);
}

const piLimitFields = {
	piMaxBytes: Type.Optional(Type.Integer({ description: "Client-side max bytes override (clamped by config)." })),
	piMaxLines: Type.Optional(Type.Integer({ description: "Client-side max lines override (clamped by config)." })),
};

const scrapeParams = Type.Object(
	{
		url: Type.String({ description: "Target URL." }),
		formats: Type.Optional(Type.Array(Type.String())),
		onlyMainContent: Type.Optional(Type.Boolean()),
		waitFor: Type.Optional(Type.Integer()),
		timeout: Type.Optional(Type.Integer()),
		mobile: Type.Optional(Type.Boolean()),
		includeTags: Type.Optional(Type.Array(Type.String())),
		excludeTags: Type.Optional(Type.Array(Type.String())),
		skipTlsVerification: Type.Optional(Type.Boolean()),
		...piLimitFields,
	},
	{ additionalProperties: true },
);

const mapParams = Type.Object(
	{
		url: Type.String({ description: "Base URL to map." }),
		search: Type.Optional(Type.String()),
		sitemap: Type.Optional(StringEnum(["include", "skip", "only"] as const, { description: "Sitemap handling mode." })),
		includeSubdomains: Type.Optional(Type.Boolean()),
		limit: Type.Optional(Type.Integer()),
		ignoreQueryParameters: Type.Optional(Type.Boolean()),
		...piLimitFields,
	},
	{ additionalProperties: true },
);

const searchParams = Type.Object(
	{
		query: Type.String({ description: "Search query." }),
		limit: Type.Optional(Type.Integer()),
		lang: Type.Optional(Type.String()),
		country: Type.Optional(Type.String()),
		scrapeOptions: Type.Optional(Type.Object({}, { additionalProperties: true })),
		...piLimitFields,
	},
	{ additionalProperties: true },
);

export {
	parseTimeoutMs,
	normalizeNumber,
	normalizeTools,
	normalizeHeaders,
	splitParams,
	resolveEffectiveLimits,
	ensureDefaultConfigFile,
	DEFAULT_CONFIG_FILE,
	CONFIG_FILENAME,
};

export default function piFirecrawl(pi: ExtensionAPI) {
	pi.registerFlag("firecrawl-url", {
		description: "Override the Firecrawl API base URL.",
		type: "string",
	});
	pi.registerFlag("firecrawl-api-key", {
		description: "Firecrawl API key (used as Authorization Bearer token).",
		type: "string",
	});
	pi.registerFlag("firecrawl-timeout-ms", {
		description: "HTTP timeout for API requests (milliseconds).",
		type: "string",
	});
	pi.registerFlag("firecrawl-config", {
		description: `Path to JSON config file (defaults to ~/.pi/agent/extensions/${CONFIG_FILENAME}).`,
		type: "string",
	});
	pi.registerFlag("firecrawl-tools", {
		description: "Comma-separated list of Firecrawl tools to register.",
		type: "string",
	});
	pi.registerFlag("firecrawl-max-bytes", {
		description: "Max bytes to keep from tool output (default: 51200).",
		type: "string",
	});
	pi.registerFlag("firecrawl-max-lines", {
		description: "Max lines to keep from tool output (default: 2000).",
		type: "string",
	});

	function getConfig(): FirecrawlRequestConfig {
		const configFlag = pi.getFlag("firecrawl-config");
		const config = loadConfig(typeof configFlag === "string" ? configFlag : undefined);

		const urlFlag = pi.getFlag("firecrawl-url");
		const apiKeyFlag = pi.getFlag("firecrawl-api-key");
		const timeoutFlag = pi.getFlag("firecrawl-timeout-ms");
		const toolsFlag = pi.getFlag("firecrawl-tools");
		const maxBytesFlag = pi.getFlag("firecrawl-max-bytes");
		const maxLinesFlag = pi.getFlag("firecrawl-max-lines");

		const apiKey =
			typeof apiKeyFlag === "string" ? apiKeyFlag : (process.env.FIRECRAWL_API_KEY ?? config?.apiKey ?? undefined);

		const baseUrl =
			typeof urlFlag === "string" ? urlFlag : (process.env.FIRECRAWL_URL ?? config?.url ?? DEFAULT_BASE_URL);

		const timeoutValue =
			typeof timeoutFlag === "string" ? timeoutFlag : (process.env.FIRECRAWL_TIMEOUT_MS ?? config?.timeoutMs);
		const timeoutMs = parseTimeoutMs(timeoutValue, DEFAULT_TIMEOUT_MS);

		const headers: Record<string, string> = { ...(config?.headers ?? {}) };
		if (apiKey && !headers.Authorization && !headers.authorization) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const tools =
			typeof toolsFlag === "string"
				? normalizeTools(toolsFlag)
				: normalizeTools(process.env.FIRECRAWL_TOOLS ?? config?.tools);

		const maxBytes =
			typeof maxBytesFlag === "string"
				? normalizeNumber(maxBytesFlag)
				: normalizeNumber(process.env.FIRECRAWL_MAX_BYTES ?? config?.maxBytes);
		const maxLines =
			typeof maxLinesFlag === "string"
				? normalizeNumber(maxLinesFlag)
				: normalizeNumber(process.env.FIRECRAWL_MAX_LINES ?? config?.maxLines);

		return { baseUrl, headers, timeoutMs, apiKey, tools, maxBytes, maxLines };
	}

	const initialConfig = getConfig();
	const allowedTools = initialConfig.tools
		? new Set(
				initialConfig.tools.filter(
					(name) => name === "firecrawl_scrape" || name === "firecrawl_map" || name === "firecrawl_search",
				),
			)
		: null;

	const registerTool = <TParams extends TSchema>(
		name: "firecrawl_scrape" | "firecrawl_map" | "firecrawl_search",
		label: string,
		description: string,
		promptSnippet: string,
		parameters: TParams,
		path: string,
	) => {
		if (allowedTools && !allowedTools.has(name)) return;

		pi.registerTool({
			name,
			label,
			description,
			promptSnippet,
			parameters,
			async execute(_toolCallId, params: Static<TParams>, signal, onUpdate, _ctx) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled." }], details: { cancelled: true } };
				}
				onUpdate?.({
					content: [{ type: "text", text: "Querying Firecrawl API..." }],
					details: { status: "pending" },
				});

				const config = getConfig();
				const safeBaseUrl = redactUrl(config.baseUrl, config.apiKey);
				const maxLimits = resolveMaxLimits(config);
				const { apiArgs, requestedLimits } = splitParams(params as Record<string, unknown>);
				const effectiveLimits = resolveEffectiveLimits(requestedLimits, maxLimits);

				try {
					const response = await firecrawlFetch(config, path, apiArgs, signal);
					const responseText = formatResponse(name, response);
					const { text, details } = formatToolOutput(name, safeBaseUrl, responseText, effectiveLimits);
					return { content: [{ type: "text", text }], details };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw Object.assign(new Error(`Firecrawl error: ${message}`), {
						details: { tool: name, baseUrl: safeBaseUrl, error: message },
					});
				}
			},
		});
	};

	registerTool(
		"firecrawl_scrape",
		"Firecrawl Scrape",
		"Scrape a single URL. Best when you already know the page to read. Client-side truncation; override with piMaxBytes/piMaxLines (clamped by config).",
		"firecrawl_scrape: scrape a known URL and return page content.",
		scrapeParams,
		"/v1/scrape",
	);

	registerTool(
		"firecrawl_map",
		"Firecrawl Map",
		"Discover URLs on a site. Use before selecting pages to scrape. Client-side truncation; override with piMaxBytes/piMaxLines (clamped by config).",
		"firecrawl_map: discover crawlable URLs for a site.",
		mapParams,
		"/v1/map",
	);

	registerTool(
		"firecrawl_search",
		"Firecrawl Search",
		"Search the web and optionally scrape search results. Client-side truncation; override with piMaxBytes/piMaxLines (clamped by config).",
		"firecrawl_search: search the web and optionally scrape search results.",
		searchParams,
		"/v1/search",
	);
}
