import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const FAST_COMMAND = "fast";
const FAST_FLAG = "fast";
const FAST_STATE_ENTRY = "pi-openai-fast.state";
const FAST_CONFIG_BASENAME = "pi-openai-fast.json";
const FAST_COMMAND_ARGS = ["on", "off", "status"] as const;
const FAST_SERVICE_TIER = "priority";
const DEFAULT_SUPPORTED_MODEL_KEYS = ["openai/gpt-5.4", "openai-codex/gpt-5.4"] as const;

interface FastModeState {
	active: boolean;
}

interface FastSupportedModel {
	provider: string;
	id: string;
}

interface FastConfigFile {
	persistState?: boolean;
	active?: boolean;
	supportedModels?: string[];
}

interface ResolvedFastConfig {
	configPath: string;
	persistState: boolean;
	active: boolean | undefined;
	supportedModels: FastSupportedModel[];
}

type FastPayload = {
	service_tier?: string;
	[key: string]: unknown;
};

const DEFAULT_CONFIG_FILE: FastConfigFile = {
	persistState: true,
	active: false,
	supportedModels: [...DEFAULT_SUPPORTED_MODEL_KEYS],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		projectConfigPath: join(cwd, ".pi", "extensions", FAST_CONFIG_BASENAME),
		globalConfigPath: join(homeDir, ".pi", "agent", "extensions", FAST_CONFIG_BASENAME),
	};
}

function parseSupportedModelKey(value: string): FastSupportedModel | undefined {
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
	return { provider, id };
}

function normalizeSupportedModelKeys(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const normalized: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			continue;
		}
		const parsed = parseSupportedModelKey(entry);
		if (!parsed) {
			continue;
		}
		normalized.push(`${parsed.provider}/${parsed.id}`);
	}
	return normalized;
}

function parseSupportedModels(value: readonly string[]): FastSupportedModel[];
function parseSupportedModels(value: unknown): FastSupportedModel[] | undefined;
function parseSupportedModels(value: unknown): FastSupportedModel[] | undefined {
	const normalized = normalizeSupportedModelKeys(value);
	if (normalized === undefined) {
		return undefined;
	}
	const models: FastSupportedModel[] = [];
	for (const entry of normalized) {
		const parsed = parseSupportedModelKey(entry);
		if (!parsed) {
			continue;
		}
		models.push(parsed);
	}
	return models;
}

function parseFastModeState(value: unknown): FastModeState | undefined {
	if (!isRecord(value) || typeof value.active !== "boolean") {
		return undefined;
	}
	return { active: value.active };
}

function getSavedFastModeState(ctx: ExtensionContext): FastModeState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === FAST_STATE_ENTRY) {
			return parseFastModeState(entry.data);
		}
	}
	return undefined;
}

function readConfigFile(filePath: string): FastConfigFile | null {
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) {
			return {};
		}
		const config: FastConfigFile = {};
		if (typeof parsed.persistState === "boolean") {
			config.persistState = parsed.persistState;
		}
		if (typeof parsed.active === "boolean") {
			config.active = parsed.active;
		}
		const supportedModels = normalizeSupportedModelKeys(parsed.supportedModels);
		if (supportedModels !== undefined) {
			config.supportedModels = supportedModels;
		}
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-openai-fast] Failed to read ${filePath}: ${message}`);
		return null;
	}
}

function writeConfigFile(filePath: string, config: FastConfigFile): void {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-openai-fast] Failed to write ${filePath}: ${message}`);
	}
}

function ensureDefaultConfigFile(projectConfigPath: string, globalConfigPath: string): void {
	if (existsSync(projectConfigPath) || existsSync(globalConfigPath)) {
		return;
	}
	writeConfigFile(globalConfigPath, DEFAULT_CONFIG_FILE);
}

function resolveFastConfig(cwd: string, homeDir: string = homedir()): ResolvedFastConfig {
	const { projectConfigPath, globalConfigPath } = getConfigPaths(cwd, homeDir);
	ensureDefaultConfigFile(projectConfigPath, globalConfigPath);

	const globalConfig = readConfigFile(globalConfigPath) ?? {};
	const projectConfig = readConfigFile(projectConfigPath) ?? {};
	const selectedConfigPath = existsSync(projectConfigPath) ? projectConfigPath : globalConfigPath;
	const merged = { ...globalConfig, ...projectConfig };
	const supportedModels =
		parseSupportedModels(merged.supportedModels) ?? parseSupportedModels(DEFAULT_SUPPORTED_MODEL_KEYS);

	return {
		configPath: selectedConfigPath,
		persistState: merged.persistState ?? DEFAULT_CONFIG_FILE.persistState ?? true,
		active: typeof merged.active === "boolean" ? merged.active : undefined,
		supportedModels,
	};
}

function getCurrentModelKey(model: ExtensionContext["model"]): string | undefined {
	if (!model) {
		return undefined;
	}
	return `${model.provider}/${model.id}`;
}

function isFastSupportedModel(model: ExtensionContext["model"], supportedModels: FastSupportedModel[]): boolean {
	if (!model) {
		return false;
	}
	return supportedModels.some((supported) => supported.provider === model.provider && supported.id === model.id);
}

function describeSupportedModels(supportedModels: FastSupportedModel[]): string {
	if (supportedModels.length === 0) {
		return "none configured";
	}
	return supportedModels.map((supported) => `${supported.provider}/${supported.id}`).join(", ");
}

function describeCurrentState(ctx: ExtensionContext, active: boolean, supportedModels: FastSupportedModel[]): string {
	const model = getCurrentModelKey(ctx.model) ?? "none";
	if (!active) {
		return `Fast mode is off. Current model: ${model}.`;
	}
	if (!ctx.model) {
		return `Fast mode is on. No model is selected. Supported models: ${describeSupportedModels(supportedModels)}.`;
	}
	if (isFastSupportedModel(ctx.model, supportedModels)) {
		return `Fast mode is on for ${model}.`;
	}
	return `Fast mode is on, but ${model} does not support it. Supported models: ${describeSupportedModels(supportedModels)}.`;
}

function applyFastServiceTier(payload: unknown): unknown {
	if (!isRecord(payload)) {
		return payload;
	}

	const nextPayload: FastPayload = { ...payload };
	nextPayload.service_tier = FAST_SERVICE_TIER;
	return nextPayload;
}

export default function piOpenAIFast(pi: ExtensionAPI): void {
	let state: FastModeState = { active: false };

	function persistState(config: ResolvedFastConfig): void {
		pi.appendEntry(FAST_STATE_ENTRY, state);
		if (!config.persistState) {
			return;
		}
		const nextConfig = { ...(readConfigFile(config.configPath) ?? {}), active: state.active };
		writeConfigFile(config.configPath, nextConfig);
	}

	async function enableFastMode(ctx: ExtensionContext, options?: { notify?: boolean }): Promise<void> {
		const config = resolveFastConfig(getConfigCwd(ctx));
		if (state.active) {
			if (options?.notify !== false) {
				ctx.ui.notify("Fast mode is already on.", "info");
			}
			return;
		}

		state = { active: true };
		persistState(config);

		if (options?.notify !== false) {
			ctx.ui.notify(describeCurrentState(ctx, state.active, config.supportedModels), "info");
		}
	}

	async function disableFastMode(ctx: ExtensionContext, options?: { notify?: boolean }): Promise<void> {
		const config = resolveFastConfig(getConfigCwd(ctx));
		if (!state.active) {
			if (options?.notify !== false) {
				ctx.ui.notify("Fast mode is already off.", "info");
			}
			return;
		}

		state = { active: false };
		persistState(config);

		if (options?.notify !== false) {
			ctx.ui.notify("Fast mode disabled.", "info");
		}
	}

	async function toggleFastMode(ctx: ExtensionContext): Promise<void> {
		if (state.active) {
			await disableFastMode(ctx);
			return;
		}
		await enableFastMode(ctx);
	}

	pi.registerFlag(FAST_FLAG, {
		description: "Start with OpenAI fast mode enabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand(FAST_COMMAND, {
		description: "Toggle fast mode (priority service tier for configured models)",
		getArgumentCompletions: (prefix) => {
			const items = FAST_COMMAND_ARGS.filter((value) => value.startsWith(prefix)).map((value) => ({
				value,
				label: value,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command.length === 0) {
				await toggleFastMode(ctx);
				return;
			}

			switch (command) {
				case "on":
					await enableFastMode(ctx);
					return;
				case "off":
					await disableFastMode(ctx);
					return;
				case "status":
					ctx.ui.notify(
						describeCurrentState(ctx, state.active, resolveFastConfig(getConfigCwd(ctx)).supportedModels),
						"info",
					);
					return;
				default:
					ctx.ui.notify("Usage: /fast [on|off|status]", "error");
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const config = resolveFastConfig(getConfigCwd(ctx));
		if (!state.active || !isFastSupportedModel(ctx.model, config.supportedModels)) {
			return;
		}
		return applyFastServiceTier(event.payload);
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = resolveFastConfig(getConfigCwd(ctx));
		const savedState = getSavedFastModeState(ctx);
		const persistedState =
			config.persistState && typeof config.active === "boolean" ? { active: config.active } : undefined;
		state = savedState ?? persistedState ?? { active: false };

		if (pi.getFlag(FAST_FLAG) === true) {
			if (!state.active) {
				state = { active: true };
				persistState(config);
			}
			ctx.ui.notify(describeCurrentState(ctx, state.active, config.supportedModels), "info");
			return;
		}

		if (!savedState && state.active) {
			ctx.ui.notify(describeCurrentState(ctx, state.active, config.supportedModels), "info");
		}
	});
}

export const _test = {
	FAST_COMMAND,
	FAST_FLAG,
	FAST_STATE_ENTRY,
	FAST_CONFIG_BASENAME,
	FAST_COMMAND_ARGS,
	FAST_SERVICE_TIER,
	DEFAULT_SUPPORTED_MODEL_KEYS,
	DEFAULT_CONFIG_FILE,
	getConfigPaths,
	parseFastModeState,
	parseSupportedModelKey,
	parseSupportedModels,
	readConfigFile,
	resolveFastConfig,
	isFastSupportedModel,
	describeSupportedModels,
	describeCurrentState,
	applyFastServiceTier,
};
