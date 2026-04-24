/**
 * OpenAI verbosity for pi.
 *
 * Sets OpenAI Responses `text.verbosity` for configured models via the
 * `before_provider_request` hook. Config precedence is project
 * `.pi/extensions/pi-openai-verbosity.json` over global
 * `~/.pi/agent/extensions/pi-openai-verbosity.json`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const VERBOSITY_COMMAND = "openai-verbosity";
const VERBOSITY_CONFIG_BASENAME = "pi-openai-verbosity.json";
const VERBOSITY_COMMAND_ARGS = ["status"] as const;
const DEBUG_LOG_ENV = "PI_OPENAI_VERBOSITY_DEBUG_LOG";
const SUPPORTED_PROVIDERS = ["openai-codex"] as const;
const DEFAULT_MODEL_VERBOSITY = {
	"openai-codex/gpt-5.4": "low",
	"openai-codex/gpt-5.5": "low",
	"openai-codex/gpt-5.4-mini": "low",
	"openai-codex/gpt-5.3-codex": "low",
	"openai-codex/gpt-5.3-codex-spark": "low",
	"openai-codex/gpt-5.2": "low",
	"openai-codex/codex-auto-review": "low",
} as const;

type TextVerbosity = "low" | "medium" | "high";

interface VerbosityConfigFile {
	models?: Record<string, TextVerbosity>;
}

interface ResolvedVerbosityConfig {
	configPath: string;
	models: Record<string, TextVerbosity>;
}

type VerbosityPayload = {
	text?: unknown;
	[key: string]: unknown;
};

const DEFAULT_CONFIG_FILE: VerbosityConfigFile = {
	models: { ...DEFAULT_MODEL_VERBOSITY },
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextVerbosity(value: unknown): value is TextVerbosity {
	return value === "low" || value === "medium" || value === "high";
}

function normalizeModelKey(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
		return undefined;
	}
	const provider = trimmed.slice(0, slashIndex).trim();
	const id = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !id) {
		return undefined;
	}
	if (!SUPPORTED_PROVIDERS.includes(provider as (typeof SUPPORTED_PROVIDERS)[number])) {
		return undefined;
	}
	return `${provider}/${id}`;
}

function normalizeModelVerbosityMap(value: unknown): Record<string, TextVerbosity> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return undefined;
	}

	const normalized: Record<string, TextVerbosity> = {};
	for (const [rawKey, rawVerbosity] of Object.entries(value)) {
		const key = normalizeModelKey(rawKey);
		if (!key || !isTextVerbosity(rawVerbosity)) {
			continue;
		}
		normalized[key] = rawVerbosity;
	}
	return normalized;
}

function getConfigCwd(ctx: ExtensionContext): string {
	return ctx.cwd || process.cwd();
}

function getConfigPaths(
	cwd: string,
	homeDir: string = homedir(),
): {
	projectConfigPath: string;
	globalConfigPath: string;
} {
	return {
		projectConfigPath: join(cwd, ".pi", "extensions", VERBOSITY_CONFIG_BASENAME),
		globalConfigPath: join(homeDir, ".pi", "agent", "extensions", VERBOSITY_CONFIG_BASENAME),
	};
}

function readConfigFile(filePath: string): VerbosityConfigFile | null {
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) {
			return {};
		}
		const models = normalizeModelVerbosityMap(parsed.models);
		return models === undefined ? {} : { models };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-openai-verbosity] Failed to read ${filePath}: ${message}`);
		return null;
	}
}

function writeConfigFile(filePath: string, config: VerbosityConfigFile): void {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-openai-verbosity] Failed to write ${filePath}: ${message}`);
	}
}

function ensureDefaultConfigFile(projectConfigPath: string, globalConfigPath: string): void {
	if (existsSync(projectConfigPath) || existsSync(globalConfigPath)) {
		return;
	}
	writeConfigFile(globalConfigPath, DEFAULT_CONFIG_FILE);
}

function resolveVerbosityConfig(cwd: string, homeDir: string = homedir()): ResolvedVerbosityConfig {
	const { projectConfigPath, globalConfigPath } = getConfigPaths(cwd, homeDir);
	ensureDefaultConfigFile(projectConfigPath, globalConfigPath);

	const globalConfig = readConfigFile(globalConfigPath) ?? {};
	const projectConfig = readConfigFile(projectConfigPath) ?? {};
	const selectedConfigPath = existsSync(projectConfigPath) ? projectConfigPath : globalConfigPath;

	return {
		configPath: selectedConfigPath,
		models: {
			...DEFAULT_MODEL_VERBOSITY,
			...(globalConfig.models ?? {}),
			...(projectConfig.models ?? {}),
		},
	};
}

function getCurrentModelKey(model: ExtensionContext["model"]): string | undefined {
	if (!model) {
		return undefined;
	}
	return `${model.provider}/${model.id}`;
}

function getVerbosityForModel(
	model: ExtensionContext["model"],
	models: Record<string, TextVerbosity>,
): TextVerbosity | undefined {
	const modelKey = getCurrentModelKey(model);
	return modelKey ? models[modelKey] : undefined;
}

function describeConfiguredModels(models: Record<string, TextVerbosity>): string {
	const entries = Object.entries(models);
	if (entries.length === 0) {
		return "none configured";
	}
	return entries.map(([model, verbosity]) => `${model}=${verbosity}`).join(", ");
}

function describeCurrentState(ctx: ExtensionContext, config: ResolvedVerbosityConfig): string {
	const model = getCurrentModelKey(ctx.model) ?? "none";
	const verbosity = getVerbosityForModel(ctx.model, config.models);
	if (verbosity) {
		return `OpenAI verbosity sets text.verbosity=${verbosity} for ${model}.`;
	}
	return `OpenAI verbosity has no setting configured for ${model}. Configured models: ${describeConfiguredModels(
		config.models,
	)}.`;
}

function applyTextVerbosity(payload: unknown, verbosity: TextVerbosity): unknown {
	if (!isRecord(payload)) {
		return payload;
	}

	const nextPayload: VerbosityPayload = { ...payload };
	const text = isRecord(nextPayload.text) ? { ...nextPayload.text } : {};
	text.verbosity = verbosity;
	nextPayload.text = text;
	return nextPayload;
}

function getPayloadTextVerbosity(payload: unknown): unknown {
	if (!isRecord(payload) || !isRecord(payload.text)) {
		return undefined;
	}
	return payload.text.verbosity;
}

function writeDebugLog(
	entry: Record<string, unknown>,
	debugLogPath: string | undefined = process.env[DEBUG_LOG_ENV],
): void {
	if (!debugLogPath) {
		return;
	}
	try {
		mkdirSync(dirname(debugLogPath), { recursive: true });
		appendFileSync(debugLogPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-openai-verbosity] Failed to write debug log ${debugLogPath}: ${message}`);
	}
}

export default function piOpenAIVerbosity(pi: ExtensionAPI): void {
	let cachedConfig: ResolvedVerbosityConfig | undefined;

	function refreshConfig(ctx: ExtensionContext): ResolvedVerbosityConfig {
		cachedConfig = resolveVerbosityConfig(getConfigCwd(ctx));
		return cachedConfig;
	}

	function getConfig(ctx: ExtensionContext): ResolvedVerbosityConfig {
		return cachedConfig ?? refreshConfig(ctx);
	}

	pi.registerCommand(VERBOSITY_COMMAND, {
		description: "Report configured GPT text verbosity rewrites",
		getArgumentCompletions: (prefix) => {
			const items = VERBOSITY_COMMAND_ARGS.filter((value) => value.startsWith(prefix)).map((value) => ({
				value,
				label: value,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command.length > 0 && command !== "status") {
				ctx.ui.notify("Usage: /openai-verbosity [status]", "error");
				return;
			}
			ctx.ui.notify(describeCurrentState(ctx, refreshConfig(ctx)), "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = getCurrentModelKey(ctx.model) ?? null;
		const beforeTextVerbosity = getPayloadTextVerbosity(event.payload);
		const verbosity = getVerbosityForModel(ctx.model, getConfig(ctx).models);
		if (!verbosity) {
			writeDebugLog({
				stage: "skipped",
				model,
				matched: false,
				beforeTextVerbosity: beforeTextVerbosity ?? null,
				payload: event.payload,
			});
			return;
		}
		writeDebugLog({
			stage: "before",
			model,
			matched: true,
			configuredVerbosity: verbosity,
			beforeTextVerbosity: beforeTextVerbosity ?? null,
			payload: event.payload,
		});
		const nextPayload = applyTextVerbosity(event.payload, verbosity);
		writeDebugLog({
			stage: "after",
			model,
			matched: true,
			configuredVerbosity: verbosity,
			beforeTextVerbosity: beforeTextVerbosity ?? null,
			afterTextVerbosity: getPayloadTextVerbosity(nextPayload) ?? null,
			payload: nextPayload,
		});
		return nextPayload;
	});
}

export const _test = {
	VERBOSITY_COMMAND,
	VERBOSITY_CONFIG_BASENAME,
	VERBOSITY_COMMAND_ARGS,
	SUPPORTED_PROVIDERS,
	DEFAULT_MODEL_VERBOSITY,
	DEFAULT_CONFIG_FILE,
	isTextVerbosity,
	normalizeModelKey,
	normalizeModelVerbosityMap,
	getConfigPaths,
	readConfigFile,
	resolveVerbosityConfig,
	getCurrentModelKey,
	getVerbosityForModel,
	describeConfiguredModels,
	describeCurrentState,
	applyTextVerbosity,
	getPayloadTextVerbosity,
	writeDebugLog,
};
