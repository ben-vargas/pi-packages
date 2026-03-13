import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const FAST_COMMAND = "fast";
const FAST_FLAG = "fast";
const FAST_STATE_ENTRY = "pi-openai-fast.state";
const FAST_COMMAND_ARGS = ["on", "off", "status"] as const;
const FAST_SERVICE_TIER = "priority";
const FAST_SUPPORTED_MODELS = [
	{ provider: "openai", id: "gpt-5.4" },
	{ provider: "openai-codex", id: "gpt-5.4" },
] as const;

interface FastModeState {
	active: boolean;
}

type FastPayload = {
	service_tier?: string;
	[key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function getCurrentModelKey(model: ExtensionContext["model"]): string | undefined {
	if (!model) {
		return undefined;
	}
	return `${model.provider}/${model.id}`;
}

function isFastSupportedModel(model: ExtensionContext["model"]): boolean {
	if (!model) {
		return false;
	}
	return FAST_SUPPORTED_MODELS.some((supported) => supported.provider === model.provider && supported.id === model.id);
}

function describeSupportedModels(): string {
	return FAST_SUPPORTED_MODELS.map((supported) => `${supported.provider}/${supported.id}`).join(", ");
}

function describeCurrentState(ctx: ExtensionContext, active: boolean): string {
	const model = getCurrentModelKey(ctx.model) ?? "none";
	if (!active) {
		return `Fast mode is off. Current model: ${model}.`;
	}
	if (!ctx.model) {
		return `Fast mode is on. No model is selected. Supported models: ${describeSupportedModels()}.`;
	}
	if (isFastSupportedModel(ctx.model)) {
		return `Fast mode is on for ${model}.`;
	}
	return `Fast mode is on, but ${model} does not support it. Supported models: ${describeSupportedModels()}.`;
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

	function persistState(): void {
		pi.appendEntry(FAST_STATE_ENTRY, state);
	}

	async function enableFastMode(ctx: ExtensionContext, options?: { notify?: boolean }): Promise<void> {
		if (state.active) {
			if (options?.notify !== false) {
				ctx.ui.notify("Fast mode is already on.", "info");
			}
			return;
		}

		state = { active: true };
		persistState();

		if (options?.notify !== false) {
			ctx.ui.notify(describeCurrentState(ctx, state.active), "info");
		}
	}

	async function disableFastMode(ctx: ExtensionContext, options?: { notify?: boolean }): Promise<void> {
		if (!state.active) {
			if (options?.notify !== false) {
				ctx.ui.notify("Fast mode is already off.", "info");
			}
			return;
		}

		state = { active: false };
		persistState();

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
		description: "Toggle fast mode (priority service tier for supported OpenAI GPT-5.4 models)",
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
					ctx.ui.notify(describeCurrentState(ctx, state.active), "info");
					return;
				default:
					ctx.ui.notify("Usage: /fast [on|off|status]", "error");
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!state.active || !isFastSupportedModel(ctx.model)) {
			return;
		}
		return applyFastServiceTier(event.payload);
	});

	pi.on("session_start", async (_event, ctx) => {
		state = getSavedFastModeState(ctx) ?? { active: false };

		if (pi.getFlag(FAST_FLAG) === true && !state.active) {
			await enableFastMode(ctx, { notify: true });
		}
	});
}

export const _test = {
	FAST_COMMAND,
	FAST_FLAG,
	FAST_STATE_ENTRY,
	FAST_COMMAND_ARGS,
	FAST_SERVICE_TIER,
	FAST_SUPPORTED_MODELS,
	parseFastModeState,
	isFastSupportedModel,
	describeCurrentState,
	applyFastServiceTier,
};
