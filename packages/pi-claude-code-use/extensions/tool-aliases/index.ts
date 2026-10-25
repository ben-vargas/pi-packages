// ============================================================================
// MCP-style tool aliasing (on by default)
//
// Anthropic's OAuth endpoint routes requests carrying some flat custom tool
// names to extra usage (verified live 2026-10-25: `web_search_exa` and
// `get_code_context_exa` each trigger it), so this module presents every
// non-core flat tool to the model under a derived `mcp__<server>__<tool>`
// alias. Disable it with PI_CLAUDE_CODE_USE_TOOL_ALIASES=0 or
// `"toolAliasing": false` in pi-claude-code-use.json.
//
// Flow while enabled:
//   1. registry: register a schema-only, model-only alias tool for each
//      non-core flat tool, and keep alias activation in sync with the source.
//   2. payload: rename flat tools to their aliases in OAuth requests (top-level
//      list, inline tool definitions, tool changes, tool_choice, history).
//   3. registry: rewrite alias tool calls back to the flat name at
//      message_end, before Pi resolves which tool to execute.
//   4. render: display aliases under their flat names in transcript prose.
// ============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transformToolPayload } from "./payload.js";
import { registerMcpAliases, syncAliasActivation, unaliasToolCalls } from "./registry.js";
import { unaliasDisplayedProse } from "./render.js";

export interface ToolAliasing {
	/** Register or refresh aliases for the current tool registry. */
	refresh(cwd: string | undefined): void;
	/** Activate aliases alongside active sources while OAuth is in use, and remove them otherwise. */
	syncActivation(oauth: boolean): void;
	/** Assistant message with alias tool calls renamed to their flat source, or undefined when unchanged. */
	unaliasMessage(message: unknown): unknown;
	/** Alias the tools of an already cloned Anthropic OAuth request in place. */
	transformPayload(payload: Record<string, unknown>): void;
}

export function createToolAliasing(pi: ExtensionAPI): ToolAliasing {
	// Display-only prose un-cloaking. The API is new in pi 0.84 while the peer
	// floor is 0.77, so feature-detect instead of raising the floor.
	if (typeof pi.registerMarkdownTransformer === "function") {
		pi.registerMarkdownTransformer(unaliasDisplayedProse);
	}
	return {
		refresh: (cwd) => registerMcpAliases(pi, { cwd }),
		syncActivation: (oauth) => syncAliasActivation(pi, oauth),
		unaliasMessage: unaliasToolCalls,
		transformPayload: (payload) => transformToolPayload(payload, pi.getActiveTools()),
	};
}
