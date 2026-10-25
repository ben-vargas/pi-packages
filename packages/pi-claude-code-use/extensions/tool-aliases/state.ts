import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lower } from "../shared.js";

export type ToolAliasPair = readonly [flatName: string, mcpName: string];
export type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];
export type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

// ============================================================================
// Constants
// ============================================================================

/**
 * Core Claude Code tool names that always pass through Anthropic OAuth filtering.
 * Stored lowercase for case-insensitive matching.
 * Mirrors Pi core's claudeCodeTools list in packages/ai/src/api/anthropic-messages.ts
 */
export const CORE_TOOL_NAMES = new Set([
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

/** Anthropic's maximum tool name length. */
export const MAX_TOOL_NAME_LENGTH = 128;

/** Pi 0.86's transport-owned, permanently deferred cache-prefix anchor. */
export const PI_DEFERRED_PLACEHOLDER = "__pi_deferred_placeholder__";

/** Generic build/source directory names skipped when deriving an alias server segment from a path. */
export const GENERIC_DIR_NAMES = new Set(["extensions", "src", "dist", "lib", "build", "out"]);

/** Flat tool name (lowercase) → MCP-style alias. Rebuilt on every alias registration pass. */
export const FLAT_TO_MCP = new Map<string, string>();

/** Reverse map: MCP-prefixed alias (lowercase) → canonical flat name. Used by `unaliasToolCalls`. */
export const MCP_TO_FLAT = new Map<string, string>();

export function refreshAliasMap(userToolAliases: ToolAliasPair[], derivedPairs: ToolAliasPair[] = []): void {
	FLAT_TO_MCP.clear();
	MCP_TO_FLAT.clear();
	for (const [flat, mcp] of derivedPairs) {
		FLAT_TO_MCP.set(lower(flat), mcp);
		MCP_TO_FLAT.set(lower(mcp), flat);
	}
	// User-configured aliases win over derived ones.
	for (const [flat, mcp] of userToolAliases) {
		FLAT_TO_MCP.set(lower(flat), mcp);
		MCP_TO_FLAT.set(lower(mcp), flat);
	}
}

export const registeredMcpAliases = new Set<string>();
export const autoActivatedAliases = new Set<string>();
/** Active tool list after the last activation sync; the baseline for detecting user picker changes. */
export const activationState: { lastManagedToolList: string[] | undefined } = { lastManagedToolList: undefined };

/** flat tool name (lowercase) → auto-derived MCP alias. Keeps derived assignments stable within a session. User overrides are intentionally NOT stored here so removing an override reverts to derivation. */
export const aliasAssignments = new Map<string, string>();

/** Permanent record: alias name (lowercase) → flat source tool name, for every alias this extension registered. Never cleared, so stale aliases keep resolving after config changes. */
export const registeredAliasRoutes = new Map<string, string>();

/** alias name (lowercase) → source metadata snapshot used at registration, to detect source schema updates. */
export interface AliasSourceMeta {
	description: string;
	parameters: unknown;
	promptGuidelines: unknown;
	exposure: unknown;
}
export const aliasSourceMeta = new Map<string, AliasSourceMeta>();

/** alias name (lowercase) → the EXACT alias name last registered with pi. Pi keys registrations by exact name, so a case-only change introduces (and auto-activates) a new tool name. */
export const aliasExactNames = new Map<string, string>();
