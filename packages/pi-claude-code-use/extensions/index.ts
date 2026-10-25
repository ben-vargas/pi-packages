import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rewritePromptText, rewriteSystemField, rewriteSystemPrompts } from "./prompt.js";
import { isPlainObject, isToolAliasingEnabled, lower } from "./shared.js";
import { createToolAliasing } from "./tool-aliases/index.js";
import {
	collectToolNames,
	filterAndRemapTools,
	remapMessageToolNames,
	remapToolChoice,
	transformToolPayload,
} from "./tool-aliases/payload.js";
import {
	deriveAliasBase,
	deriveServerSegment,
	extractToolAliasPairs,
	loadToolAliases,
	registerMcpAliases,
	reserveAliasName,
	sanitizeAliasSegment,
	syncAliasActivation,
	unaliasToolCalls,
} from "./tool-aliases/registry.js";
import { sanitizeResultText, truncateCodePoints, unaliasDisplayedProse } from "./tool-aliases/render.js";
import {
	activationState,
	aliasAssignments,
	aliasExactNames,
	aliasSourceMeta,
	autoActivatedAliases,
	CORE_TOOL_NAMES,
	FLAT_TO_MCP,
	MCP_TO_FLAT,
	refreshAliasMap,
	registeredAliasRoutes,
	registeredMcpAliases,
} from "./tool-aliases/state.js";

// ============================================================================
// Debug logging
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
// Payload transform
// ============================================================================

interface TransformOptions {
	/** Alias tools as well (opt-in tool aliasing). */
	aliasTools?: boolean;
	/** Active tool names, used to hide aliases whose source Pi left undeclared. */
	activeToolNames?: readonly string[];
}

/** Rewrite an Anthropic OAuth request. Returns a new payload; the input is not mutated. */
function transformPayload(raw: Record<string, unknown>, options: TransformOptions = {}): Record<string, unknown> {
	const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
	rewriteSystemPrompts(payload);
	if (options.aliasTools) transformToolPayload(payload, options.activeToolNames);
	return payload;
}

// ============================================================================
// Extension entry point
// ============================================================================

export default async function piClaudeCodeUse(pi: ExtensionAPI): Promise<void> {
	const aliasing = createToolAliasing(pi);
	// Decided per session from the env var and config; resolved on first use when
	// a hook runs before session_start.
	let aliasingEnabled: boolean | undefined;
	const isAliasingEnabled = (cwd: unknown): boolean => {
		aliasingEnabled ??= isToolAliasingEnabled(typeof cwd === "string" ? cwd : process.cwd());
		return aliasingEnabled;
	};

	pi.on("session_start", async (_event, ctx) => {
		aliasingEnabled = undefined;
		if (isAliasingEnabled(ctx.cwd)) aliasing.refresh(ctx.cwd);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!isAliasingEnabled(ctx.cwd)) return;
		aliasing.refresh(ctx.cwd);
		const model = ctx.model;
		aliasing.syncActivation(model?.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model));
	});

	// MCP alias → flat canonical name before the agent loop resolves the tool.
	pi.on("message_end", async (event, ctx) => {
		if (!isAliasingEnabled(ctx.cwd)) return undefined;
		const rewritten = aliasing.unaliasMessage(event.message);
		return rewritten ? { message: rewritten as typeof event.message } : undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(model)) return undefined;
		if (!isPlainObject(event.payload)) return undefined;

		const enabled = isAliasingEnabled(ctx.cwd);
		const aliasTools = enabled && process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER !== "1";
		if (enabled) {
			// Catch tools registered by other extensions' before_agent_start handlers
			// that ran after ours, so their aliases exist on the first turn.
			try {
				aliasing.refresh(typeof ctx.cwd === "string" ? ctx.cwd : undefined);
			} catch {
				// Alias refresh must never break the actual request.
			}
		}

		writeDebugLog({ stage: "before", payload: event.payload });
		const transformed = transformPayload(event.payload, {
			aliasTools,
			activeToolNames: aliasTools ? pi.getActiveTools() : [],
		});
		writeDebugLog({ stage: "after", payload: transformed });
		return transformed;
	});
}

// ============================================================================
// Test exports
// ============================================================================

export const _test = {
	CORE_TOOL_NAMES,
	MCP_TO_FLAT,
	FLAT_TO_MCP,
	aliasAssignments,
	aliasExactNames,
	aliasSourceMeta,
	autoActivatedAliases,
	registeredAliasRoutes,
	collectToolNames,
	deriveAliasBase,
	deriveServerSegment,
	extractToolAliasPairs,
	filterAndRemapTools,
	getLastManagedToolList: () => activationState.lastManagedToolList,
	isPlainObject,
	isToolAliasingEnabled,
	loadToolAliases,
	lower,
	refreshAliasMap,
	registerMcpAliases,
	registeredMcpAliases,
	remapMessageToolNames,
	remapToolChoice,
	reserveAliasName,
	rewritePromptText,
	rewriteSystemField,
	sanitizeAliasSegment,
	sanitizeResultText,
	truncateCodePoints,
	setLastManagedToolList: (v: string[] | undefined) => {
		activationState.lastManagedToolList = v;
	},
	syncAliasActivation,
	transformPayload,
	unaliasDisplayedProse,
	unaliasToolCalls,
};
