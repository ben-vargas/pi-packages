import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
	keyHint,
	keyText,
	type MarkdownTransformContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, getImageDimensions, imageFallback, Text } from "@earendil-works/pi-tui";

// ============================================================================
// Types
// ============================================================================

type ToolAliasPair = readonly [flatName: string, mcpName: string];

type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

// ============================================================================
// Compact alias result rendering
//
// getAllTools() does not expose source tool renderers, so live alias rows
// (rendered under the mcp__ name before the message_end rewrite) use this
// compact generic result renderer. It mirrors Pi's default result rendering
// pipeline: terminal-safe output normalization, image handling that matches
// ToolExecutionComponent's inline-image behavior, and a keybinding-aware
// expansion hint. Restored sessions persist the flat tool name, so resumed
// transcripts render with the source tool's own renderers instead.
// ============================================================================

const MAX_COLLAPSED_RESULT_LINES = 3;
const MAX_COLLAPSED_RESULT_CHARS = 2000;

// Matches ANSI CSI and OSC escape sequences (string terminator: BEL, ESC\, or
// 0x9c). Based on Pi core's vendored ansi-regex (MIT, Sindre Sorhus), extended
// to recognize the 8-bit C1 OSC introducer (0x9d) as well as ESC ]. Pi does not
// export its sanitizers publicly, so this is kept local instead of deep-importing
// private dist modules.
const TERMINAL_SEQUENCE_PATTERN = new RegExp(
	"(?:(?:\\u001B\\]|\\u009D)[\\s\\S]*?(?:\\u0007|\\u001B\\u005C|\\u009C))" +
		"|[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]",
	"g",
);

/**
 * Terminal-safe normalization for displayed tool result text. This follows
 * `getTextOutput` in Pi core's render-utils, then hardens its normalization by
 * recognizing C1-form OSC and removing every remaining C1 control. Tabs,
 * newlines, and valid printable Unicode are preserved.
 */
function sanitizeResultText(text: string): string {
	const stripped =
		text.includes("\u001b") || text.includes("\u009b") || text.includes("\u009d")
			? text.replace(TERMINAL_SEQUENCE_PATTERN, "")
			: text;
	let result = "";
	for (const char of stripped) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		if (code === 0x09 || code === 0x0a) {
			result += char; // Keep tabs and newlines.
			continue;
		}
		// Drop C0 (including \r), DEL, and all 8-bit C1 controls. Sequence
		// introducers left behind by malformed/unterminated input are safe too.
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
		if (code >= 0xd800 && code <= 0xdfff) continue; // Lone surrogates (paired ones yield code points > 0xffff).
		if (code >= 0xfff9 && code <= 0xfffb) continue; // Unicode interlinear format characters.
		result += char;
	}
	return result;
}

/** Truncate to a maximum number of Unicode code points without splitting surrogate pairs. */
function truncateCodePoints(text: string, maxCodePoints: number): { text: string; truncated: boolean } {
	// A string's UTF-16 length is always >= its code point count.
	if (text.length <= maxCodePoints) return { text, truncated: false };
	let end = 0;
	let count = 0;
	for (const char of text) {
		if (count === maxCodePoints) return { text: text.slice(0, end), truncated: true };
		count += 1;
		end += char.length;
	}
	return { text, truncated: false };
}

/**
 * Keybinding-aware "… (ctrl+o to expand)" hint. `keyHint` resolves the user's
 * configured binding but requires Pi's interactive theme to be initialized;
 * outside the TUI (tests, non-interactive modes) fall back to composing the
 * hint from the render theme that Pi passed in.
 */
function collapsedExpansionHint(theme: Theme): string {
	let hint: string;
	try {
		hint = keyHint("app.tools.expand", "to expand");
	} catch {
		hint = theme.fg("dim", keyText("app.tools.expand") || "ctrl+o") + theme.fg("muted", " to expand");
	}
	return `${theme.fg("muted", "… (")}${hint}${theme.fg("muted", ")")}`;
}

/** Keeps renderer-less alias results compact while preserving full output for expansion. */
class CompactAliasResult implements Component {
	private readonly content: Text;
	private readonly hint: Text;
	private readonly expanded: boolean;
	private readonly truncatedByChars: boolean;

	constructor(text: string, hint: string, expanded: boolean, truncatedByChars: boolean) {
		this.content = new Text(text, 0, 0);
		this.hint = new Text(hint, 0, 0);
		this.expanded = expanded;
		this.truncatedByChars = truncatedByChars;
	}

	render(width: number): string[] {
		const lines = this.content.render(width);
		if (this.expanded || (!this.truncatedByChars && lines.length <= MAX_COLLAPSED_RESULT_LINES)) return lines;
		return [...lines.slice(0, MAX_COLLAPSED_RESULT_LINES), ...this.hint.render(width)];
	}

	invalidate(): void {
		this.content.invalidate();
		this.hint.invalidate();
	}
}

type AliasResultPart = { type: string; text?: string; data?: string; mimeType?: string };

function renderCompactAliasResult(
	content: readonly AliasResultPart[],
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	showImages: boolean,
): Component {
	const textOutput = content
		.filter((part) => part.type === "text")
		.map((part) => sanitizeResultText(part.text ?? ""))
		.join("\n");
	const imageParts = content.filter((part) => part.type === "image");
	// Pi's ToolExecutionComponent appends inline Image components below the tool
	// row when the terminal supports them and images are shown. Emit a textual
	// placeholder only when it will not (mirrors Pi core's getTextOutput). Like
	// getTextOutput, this treats capability + showImages as "inline" even for
	// parts missing data/mimeType or non-PNGs that kitty fails to convert —
	// Pi core skips those inline images too, so such edge cases render nothing
	// rather than a duplicate placeholder.
	const imagesInline = imageParts.length > 0 && showImages && getCapabilities().images !== null;
	let output = textOutput;
	if (imageParts.length > 0 && !imagesInline) {
		const indicators = imageParts
			.map((part) => {
				const mimeType = part.mimeType ?? "image/unknown";
				const dimensions =
					part.data && part.mimeType ? (getImageDimensions(part.data, part.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dimensions);
			})
			.join("\n");
		output = output ? `${output}\n${indicators}` : indicators;
	}
	// Normalize the fully assembled result, not just source text blocks:
	// imageFallback interpolates untrusted MIME text into its placeholder.
	output = sanitizeResultText(output);
	if (!output) {
		// Image-only inline results get their images from the tool row itself, and
		// partial results may still stream text in — neither is an empty result.
		if (imagesInline || options.isPartial) return new Text("", 0, 0);
		return new Text(theme.fg("toolOutput", "(empty result)"), 0, 0);
	}
	// Partial (streaming) results render through the same compact path so output
	// appears as it arrives, exactly like the finalized view.
	const truncation = options.expanded
		? { text: output, truncated: false }
		: truncateCodePoints(output, MAX_COLLAPSED_RESULT_CHARS);
	return new CompactAliasResult(
		theme.fg("toolOutput", truncation.text),
		collapsedExpansionHint(theme),
		options.expanded,
		truncation.truncated,
	);
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Core Claude Code tool names that always pass through Anthropic OAuth filtering.
 * Stored lowercase for case-insensitive matching.
 * Mirrors Pi core's claudeCodeTools list in packages/ai/src/api/anthropic-messages.ts
 */
const CORE_TOOL_NAMES = new Set([
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
const MAX_TOOL_NAME_LENGTH = 128;

/** Generic build/source directory names skipped when deriving an alias server segment from a path. */
const GENERIC_DIR_NAMES = new Set(["extensions", "src", "dist", "lib", "build", "out"]);

/** Flat tool name (lowercase) → MCP-style alias. Rebuilt on every alias registration pass. */
const FLAT_TO_MCP = new Map<string, string>();

/** Reverse map: MCP-prefixed alias (lowercase) → canonical flat name. Used by `unaliasToolCalls`. */
const MCP_TO_FLAT = new Map<string, string>();

// ============================================================================
// User-defined tool aliases (pi-claude-code-use.json)
//
//   - project: <cwd>/.pi/extensions/pi-claude-code-use.json
//   - global:  <agentDir>/extensions/pi-claude-code-use.json   (agentDir from pi)
//
// Project file's keys replace global file's via spread-merge — same effective
// behaviour as pi-core's deepMergeSettings for our top-level array key.
// Schema: { "toolAliases": [[flat, mcp], ...] }
//
// Entries act as overrides on top of automatic alias derivation: when a flat
// tool name appears here, the configured MCP name is used instead of the
// derived one.
// ============================================================================

const CONFIG_FILENAME = "pi-claude-code-use.json";

function readConfigFile(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		return isPlainObject(parsed) ? parsed : {};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-claude-code-use] Failed to read ${filePath}: ${message}`);
		return {};
	}
}

// Returns `undefined` when `toolAliases` is missing or not an array; returns
// `[]` for an explicit empty array (which disables inherited globals).
function extractToolAliasPairs(value: unknown): ToolAliasPair[] | undefined {
	if (!isPlainObject(value)) return undefined;
	const raw = (value as { toolAliases?: unknown }).toolAliases;
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		console.warn(`[pi-claude-code-use] Ignoring "toolAliases": expected array, got ${typeof raw}`);
		return undefined;
	}
	return raw.filter(
		(e): e is ToolAliasPair => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string",
	);
}

function loadToolAliases(cwd: string, agentDir: string = getAgentDir()): ToolAliasPair[] {
	const globalPath = join(agentDir, "extensions", CONFIG_FILENAME);
	const projectPath = join(cwd, ".pi", "extensions", CONFIG_FILENAME);
	const merged = { ...readConfigFile(globalPath), ...readConfigFile(projectPath) };
	return extractToolAliasPairs(merged) ?? [];
}

// ============================================================================
// Helpers
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(name: string | undefined): string {
	return (name ?? "").trim().toLowerCase();
}

function refreshAliasMap(userToolAliases: ToolAliasPair[], derivedPairs: ToolAliasPair[] = []): void {
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

// Rewrite `name` on every block of `blockType` via `mapName`. Returns the
// SAME array reference when nothing changed, so callers can use reference
// equality to skip spreading the parent object.
function remapBlockNames(
	content: unknown[],
	blockType: "tool_use" | "toolCall",
	mapName: (name: string) => string | undefined,
): unknown[] {
	let changed = false;
	const next = content.map((block) => {
		if (!isPlainObject(block) || block.type !== blockType || typeof block.name !== "string") {
			return block;
		}
		const newName = mapName(block.name);
		if (!newName || newName === block.name) return block;
		changed = true;
		return { ...block, name: newName };
	});
	return changed ? next : content;
}

// Rewrite MCP-aliased `toolCall.name`s in the finalized assistant message
// back to their canonical flat names. Fires from `message_end`, which runs
// BEFORE the agent loop resolves which tool to invoke — so Pi looks up the
// ORIGINAL extension's `execute` (preserving its closure-bound state) instead
// of this extension's schema-only alias stub. Inverse of `remapMessageToolNames`.
//
// Gated on `registeredMcpAliases`: only rewrites names that this extension
// explicitly registered, so foreign mcp__ tools (owned by other extensions)
// pass through untouched.
function unaliasToolCalls(message: unknown): unknown {
	if (!isPlainObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
		return undefined;
	}
	const content = remapBlockNames(message.content, "toolCall", (n) => {
		const nameLc = lower(n);
		if (!registeredMcpAliases.has(nameLc)) return undefined;
		// Prefer the current mapping; fall back to the permanent route recorded at
		// registration time so stale aliases (e.g. after a config change removed
		// their mapping) still resolve to their original flat tool.
		return MCP_TO_FLAT.get(nameLc) ?? registeredAliasRoutes.get(nameLc);
	});
	return content === message.content ? undefined : { ...message, content };
}

// ============================================================================
// Displayed prose un-cloaking (markdown transformer, pi >= 0.84)
//
// The model sees MCP-style aliases on the wire, so its prose mentions them
// ("I'll call `mcp__exa_mcp__web_search_exa`"), while the session and rendered
// toolCall blocks keep flat names (unaliasToolCalls at message_end). This
// display-only transformer rewrites aliases registered by THIS extension back
// to their flat source names in assistant prose so the transcript reads
// consistently. Pi applies markdown transformers only when rendering the
// interactive transcript; the session file and model context keep the
// original text. Same lookup precedence and gating as unaliasToolCalls.
// ============================================================================

// Whole-token alias mentions: "mcp__" (any case) followed by tool-name
// characters, not preceded by one (so "foo_mcp__x" is a different token).
// Longest-token matching means a superstring of a registered alias
// ("mcp__exa__search_extra") is looked up as a whole and left unchanged.
const PROSE_ALIAS_PATTERN = /(?<![A-Za-z0-9_-])mcp__[A-Za-z0-9_-]+/gi;

function unaliasDisplayedProse(markdown: string, context: MarkdownTransformContext): string {
	// Assistant prose only (final and streaming alike — skipping streaming
	// updates would make names flip when the message finalizes). User messages
	// show what the user actually typed.
	if (context.messageType !== "assistant" && context.messageType !== "assistant-thinking") {
		return markdown;
	}
	if (process.env.PI_CLAUDE_CODE_USE_DISABLE_PROSE_UNALIAS === "1") {
		return markdown;
	}
	if (registeredMcpAliases.size === 0) {
		return markdown;
	}
	return markdown.replace(PROSE_ALIAS_PATTERN, (token) => {
		const tokenLc = lower(token);
		if (!registeredMcpAliases.has(tokenLc)) return token;
		return MCP_TO_FLAT.get(tokenLc) ?? registeredAliasRoutes.get(tokenLc) ?? token;
	});
}

// ============================================================================
// System prompt rewrite (PRD §1.1)
//
// Replace "pi itself" → "the cli itself" in system prompt text.
// Preserves cache_control, non-text blocks, and payload shape.
// ============================================================================

function rewritePromptText(text: string): string {
	return text
		.replaceAll("pi itself", "the cli itself")
		.replaceAll("pi .md files", "cli .md files")
		.replaceAll("pi packages", "cli packages");
}

function rewriteSystemField(system: unknown): unknown {
	if (typeof system === "string") {
		return rewritePromptText(system);
	}
	if (!Array.isArray(system)) {
		return system;
	}
	return system.map((block) => {
		if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
			return block;
		}
		const rewritten = rewritePromptText(block.text);
		return rewritten === block.text ? block : { ...block, text: rewritten };
	});
}

// ============================================================================
// Tool filtering and MCP alias remapping (PRD §1.2)
//
// Rules applied per tool:
// 1. Anthropic-native typed tools (have a `type` field) → pass through
// 2. Core Claude Code tool names → pass through
// 3. Tools already prefixed with mcp__ → pass through
// 4. Aliased flat tools whose MCP alias is also advertised → rename to alias
// 5. Aliased flat tools without an advertised alias → filtered out
// 6. Unknown flat-named tools → filtered out (unless disableFilter)
// ============================================================================

function collectToolNames(tools: unknown[]): Set<string> {
	const names = new Set<string>();
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === "string") {
			names.add(lower(tool.name));
		}
	}
	return names;
}

function collectToolsByName(tools: unknown[]): Map<string, Record<string, unknown>> {
	const byName = new Map<string, Record<string, unknown>>();
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === "string") {
			byName.set(lower(tool.name), tool);
		}
	}
	return byName;
}

function filterAndRemapTools(tools: unknown[] | undefined, disableFilter: boolean): unknown[] | undefined {
	if (!Array.isArray(tools)) return tools;

	const advertised = collectToolNames(tools);
	const toolsByName = collectToolsByName(tools);
	const emitted = new Set<string>();
	const result: unknown[] = [];

	// Aliases (lowercase) that a flat entry in this payload will be renamed to.
	// A standalone advertised alias stub is suppressed in favor of the renamed
	// flat entry regardless of payload order, because the flat entry always
	// carries the source tool's current schema.
	const replacedByFlat = new Set<string>();
	if (!disableFilter) {
		for (const tool of tools) {
			if (!isPlainObject(tool) || typeof tool.name !== "string") continue;
			if (typeof tool.type === "string" && tool.type.trim().length > 0) continue;
			const nameLc = lower(tool.name);
			if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) continue;
			const mcpAlias = FLAT_TO_MCP.get(nameLc);
			if (!mcpAlias) continue;
			const aliasLc = lower(mcpAlias);
			if (advertised.has(aliasLc) || registeredMcpAliases.has(aliasLc)) {
				replacedByFlat.add(aliasLc);
			}
		}
	}

	for (const tool of tools) {
		if (!isPlainObject(tool)) continue;

		// Rule 1: native typed tools always pass through
		if (typeof tool.type === "string" && tool.type.trim().length > 0) {
			result.push(tool);
			continue;
		}

		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const nameLc = lower(name);

		// Rules 2 & 3: core tools and mcp__-prefixed pass through (with dedup).
		// Alias stubs that a flat entry will replace are skipped here; the
		// renamed flat entry is emitted at the flat entry's position instead.
		if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) {
			if (!emitted.has(nameLc) && !replacedByFlat.has(nameLc)) {
				emitted.add(nameLc);
				result.push(tool);
			}
			continue;
		}

		// Rules 4 & 5: flat tool with a known MCP alias. The alias qualifies when
		// it is advertised in this payload OR when this extension registered it
		// (covers aliases registered mid-turn, before activation catches up —
		// message_end unaliasing routes the call to the flat tool either way).
		const mcpAlias = FLAT_TO_MCP.get(nameLc);
		if (mcpAlias) {
			const aliasLc = lower(mcpAlias);
			if ((advertised.has(aliasLc) || registeredMcpAliases.has(aliasLc)) && !emitted.has(aliasLc)) {
				// Rename the FLAT entry: it always carries the source tool's current
				// schema, whereas an advertised alias stub can lag one turn behind a
				// mid-session source schema update. Preserve the advertised alias
				// entry's cache_control so prompt-cache breakpoints survive.
				emitted.add(aliasLc);
				const advertisedAlias = toolsByName.get(aliasLc);
				const renamed: Record<string, unknown> = { ...tool, name: mcpAlias };
				if (advertisedAlias?.cache_control !== undefined && renamed.cache_control === undefined) {
					renamed.cache_control = advertisedAlias.cache_control;
				}
				result.push(renamed);
			} else if (disableFilter && !emitted.has(nameLc)) {
				// Filter disabled: keep flat name if not yet emitted
				emitted.add(nameLc);
				result.push(tool);
			}
			continue;
		}

		// Rule 6: unknown flat-named tool
		if (disableFilter && !emitted.has(nameLc)) {
			emitted.add(nameLc);
			result.push(tool);
		}
	}

	return result;
}

function remapToolChoice(
	toolChoice: Record<string, unknown>,
	survivingNames: Map<string, string>,
): Record<string, unknown> | undefined {
	if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string") {
		return toolChoice;
	}

	const nameLc = lower(toolChoice.name);
	const actualName = survivingNames.get(nameLc);
	if (actualName) {
		return actualName === toolChoice.name ? toolChoice : { ...toolChoice, name: actualName };
	}

	const mcpAlias = FLAT_TO_MCP.get(nameLc);
	if (mcpAlias && survivingNames.has(lower(mcpAlias))) {
		return { ...toolChoice, name: mcpAlias };
	}

	return undefined;
}

function remapMessageToolNames(messages: unknown[], survivingNames: Map<string, string>): unknown[] {
	let anyChanged = false;
	const result = messages.map((msg) => {
		if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;
		const content = remapBlockNames(msg.content, "tool_use", (n) => {
			const alias = FLAT_TO_MCP.get(lower(n));
			return alias && survivingNames.has(lower(alias)) ? alias : undefined;
		});
		if (content === msg.content) return msg;
		anyChanged = true;
		return { ...msg, content };
	});
	return anyChanged ? result : messages;
}

// ============================================================================
// Full payload transform
// ============================================================================

function transformPayload(raw: Record<string, unknown>, disableFilter: boolean): Record<string, unknown> {
	// Deep clone to avoid mutating the original
	const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

	// 1. System prompt rewrite (always applies)
	if (payload.system !== undefined) {
		payload.system = rewriteSystemField(payload.system);
	}

	// When escape hatch is active, skip all tool filtering/remapping
	if (disableFilter) {
		return payload;
	}

	// 2. Tool filtering and alias remapping
	payload.tools = filterAndRemapTools(payload.tools as unknown[] | undefined, false);

	// 3. Build map of tool names that survived filtering (lowercase → actual name)
	const survivingNames = new Map<string, string>();
	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			if (isPlainObject(tool) && typeof tool.name === "string") {
				survivingNames.set(lower(tool.name), tool.name as string);
			}
		}
	}

	// 4. Remap tool_choice if it references a renamed or filtered tool
	if (isPlainObject(payload.tool_choice)) {
		const remapped = remapToolChoice(payload.tool_choice, survivingNames);
		if (remapped === undefined) {
			delete payload.tool_choice;
		} else {
			payload.tool_choice = remapped;
		}
	}

	// 5. Rewrite historical tool_use blocks in message history
	if (Array.isArray(payload.messages)) {
		payload.messages = remapMessageToolNames(payload.messages, survivingNames);
	}

	return payload;
}

// ============================================================================
// Debug logging (PRD §1.4)
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
// MCP alias derivation
//
// Anthropic's OAuth subscription endpoint refuses flat-named custom tools but
// accepts any name shaped like mcp__<server>__<tool>. Instead of maintaining a
// hardcoded list of known extensions, every non-core flat tool reported by
// pi.getAllTools() gets a deterministic MCP-style alias derived from its
// sourceInfo (the extension it came from) and its tool name.
// ============================================================================

/** Sanitize a name fragment into a lowercase [a-z0-9_] segment. */
function sanitizeAliasSegment(value: string, fallback: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned.length > 0 ? cleaned : fallback;
}

/** Strip a leading "pi-"/"pi_" prefix from an extension/package name. */
function stripPiPrefix(name: string): string {
	return name.replace(/^pi[-_]/i, "");
}

/**
 * Derive the `<server>` segment of an MCP alias from a tool's sourceInfo.
 *
 * Priority:
 * 1. Synthetic sources (`<builtin:...>`, `<sdk:...>`) → "pi".
 * 2. npm installs → unscoped package name from the node_modules path.
 * 3. Single-file extensions → file stem (when not "index").
 * 4. Directory-based extensions → nearest non-generic directory name
 *    (skipping extensions/src/dist/lib/build/out), falling back to baseDir.
 */
function deriveServerSegment(sourceInfo: ToolInfo["sourceInfo"] | undefined): string {
	const rawPath = (sourceInfo?.path ?? "").replaceAll("\\", "/");
	if (!rawPath || rawPath.startsWith("<")) return "pi";

	// npm install: use the package name from the node_modules path.
	const nmIdx = rawPath.lastIndexOf("/node_modules/");
	if (nmIdx !== -1) {
		const segments = rawPath
			.slice(nmIdx + "/node_modules/".length)
			.split("/")
			.filter(Boolean);
		const pkg = segments[0]?.startsWith("@") ? segments[1] : segments[0];
		if (pkg) return sanitizeAliasSegment(stripPiPrefix(pkg), "ext");
	}

	const segments = rawPath.split("/").filter(Boolean);
	const fileName = segments.pop() ?? "";

	// Single-file extension: use the file stem when it is meaningful.
	const stem = fileName.replace(/\.[^.]*$/, "");
	if (stem && stem !== "index") return sanitizeAliasSegment(stripPiPrefix(stem), "ext");

	// Walk up past generic build/source directory names.
	while (segments.length > 0 && GENERIC_DIR_NAMES.has(segments[segments.length - 1] ?? "")) {
		segments.pop();
	}
	const dirName = segments[segments.length - 1];
	if (dirName && !/^[a-zA-Z]:$/.test(dirName)) return sanitizeAliasSegment(stripPiPrefix(dirName), "ext");

	return "ext";
}

/** Derive the base (pre-collision-handling) MCP alias for a tool. */
function deriveAliasBase(tool: ToolInfo): string {
	const server = deriveServerSegment(tool.sourceInfo);
	const toolSegment = sanitizeAliasSegment(tool.name, "tool");
	return `mcp__${server}__${toolSegment}`;
}

/**
 * Resolve `base` against `taken` (lowercase name set), appending a numeric
 * suffix (`_2`, `_3`, ...) on collision. The result always fits Anthropic's
 * 128-char tool name limit. Deterministic for a given base + taken set.
 */
function reserveAliasName(base: string, taken: Set<string>): string {
	let candidate = base.slice(0, MAX_TOOL_NAME_LENGTH);
	let counter = 2;
	while (taken.has(lower(candidate))) {
		const suffix = `_${counter}`;
		candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
		counter += 1;
	}
	return candidate;
}

// ============================================================================
// MCP alias registration
//
// At session start and before each agent turn, reads the live tool registry
// via pi.getAllTools() and registers a schema-only MCP alias for every
// non-core flat tool. This includes tools that other extensions register from
// lifecycle hooks (e.g. pi-web-providers), which a static capture of the
// extension factory would miss.
//
// Alias tools carry the source tool's schema, description, and prompt
// guidelines, but a stub execute: managed alias calls are rewritten back to
// their flat source names at `message_end` before Pi resolves execution, so
// the ORIGINAL extension's execute always runs.
// ============================================================================

const registeredMcpAliases = new Set<string>();
const autoActivatedAliases = new Set<string>();
let lastManagedToolList: string[] | undefined;

/** flat tool name (lowercase) → auto-derived MCP alias. Keeps derived assignments stable within a session. User overrides are intentionally NOT stored here so removing an override reverts to derivation. */
const aliasAssignments = new Map<string, string>();

/** Permanent record: alias name (lowercase) → flat source tool name, for every alias this extension registered. Never cleared, so stale aliases keep resolving after config changes. */
const registeredAliasRoutes = new Map<string, string>();

/** alias name (lowercase) → source metadata snapshot used at registration, to detect source schema updates. */
interface AliasSourceMeta {
	description: string;
	parameters: unknown;
	promptGuidelines: unknown;
}
const aliasSourceMeta = new Map<string, AliasSourceMeta>();

/** alias name (lowercase) → the EXACT alias name last registered with pi. Pi keys registrations by exact name, so a case-only change introduces (and auto-activates) a new tool name. */
const aliasExactNames = new Map<string, string>();

/**
 * Promote auto-activated aliases to user-selected when the user deliberately
 * kept the alias while removing its flat counterpart from the tool picker.
 * Detected via the last managed baseline: the flat tool was previously
 * managed, is no longer active, and the alias is still active. Comparisons
 * are case-insensitive (FLAT_TO_MCP keys are lowercased; pi names are exact).
 */
function promoteKeptAliases(activeNames: string[], desiredSet: ReadonlySet<string>): void {
	if (lastManagedToolList === undefined) return;
	const activeSet = new Set(activeNames);
	const activeLc = new Set(activeNames.map(lower));
	const lastManagedLc = new Set(lastManagedToolList.map(lower));
	for (const alias of [...autoActivatedAliases]) {
		if (!activeSet.has(alias) || desiredSet.has(alias)) continue;
		const flatLc = [...FLAT_TO_MCP.entries()].find(([, mcp]) => mcp === alias)?.[0];
		if (flatLc && lastManagedLc.has(flatLc) && !activeLc.has(flatLc)) {
			autoActivatedAliases.delete(alias);
		}
	}
}

function registerMcpAliases(pi: ExtensionAPI, opts: { cwd?: string; agentDir?: string } = {}): void {
	// Pick up user-defined tool aliases so subsequent payload transforms
	// (filterAndRemapTools, remapToolChoice, message rewriting) see them.
	const userToolAliases = loadToolAliases(opts.cwd ?? process.cwd(), opts.agentDir);
	const disableAutoAlias = process.env.PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS === "1";

	const allTools = pi.getAllTools();
	const toolIndex = new Map<string, ToolInfo>();
	for (const tool of allTools) {
		toolIndex.set(lower(tool.name), tool);
	}

	// Names unavailable for newly derived aliases: every currently registered
	// tool plus every valid user-configured alias target.
	const taken = new Set(toolIndex.keys());

	// Aliasable tools, in deterministic order so collision suffixes are stable.
	const aliasable = allTools
		.filter((tool) => {
			const nameLc = lower(tool.name);
			return nameLc.length > 0 && !CORE_TOOL_NAMES.has(nameLc) && !nameLc.startsWith("mcp__");
		})
		.sort((a, b) => (lower(a.name) < lower(b.name) ? -1 : 1));

	// Case-insensitive duplicate flat names are excluded from aliasing (and
	// from user overrides): all alias state is keyed by lowercased names while
	// pi's execution lookup is exact-name, so aliasing either variant could
	// route a call for one tool to the other.
	const flatNameCounts = new Map<string, number>();
	for (const tool of aliasable) {
		const flatLc = lower(tool.name);
		flatNameCounts.set(flatLc, (flatNameCounts.get(flatLc) ?? 0) + 1);
	}
	const isDuplicateFlat = (flatLc: string): boolean => (flatNameCounts.get(flatLc) ?? 0) > 1;

	// Validate user overrides. Invalid entries are fully ignored: they are
	// excluded from registration AND from the alias maps, so derivation and
	// payload remapping fall back to the derived alias.
	const warnIgnored = (flat: string, mcp: string, reason: string): void => {
		console.warn(`[pi-claude-code-use] Ignoring toolAliases entry ["${flat}", "${mcp}"]: ${reason}`);
	};
	const validUserAliases: ToolAliasPair[] = [];
	const userOverrides = new Map<string, string>();
	const overrideTargets = new Set<string>();
	for (const [flat, mcp] of userToolAliases) {
		const mcpLc = lower(mcp);
		if (isDuplicateFlat(lower(flat))) {
			warnIgnored(flat, mcp, "flat tool name has a case-insensitive duplicate in the registry");
			continue;
		}
		if (mcp !== mcp.trim()) {
			warnIgnored(flat, mcp, "alias has surrounding whitespace");
			continue;
		}
		if (!mcpLc.startsWith("mcp__")) {
			warnIgnored(flat, mcp, 'alias must start with "mcp__"');
			continue;
		}
		if (mcp.length > MAX_TOOL_NAME_LENGTH) {
			warnIgnored(flat, mcp, `alias exceeds ${MAX_TOOL_NAME_LENGTH} characters`);
			continue;
		}
		if (overrideTargets.has(mcpLc)) {
			warnIgnored(flat, mcp, "alias is already used by another toolAliases entry");
			continue;
		}
		// The target may already exist as a tool only when this extension
		// registered it for the same flat tool. A foreign tool with that name, or
		// an alias we registered for a DIFFERENT flat tool, must not be re-routed.
		const ownedFor = registeredAliasRoutes.get(mcpLc);
		if (toolIndex.has(mcpLc) && !registeredMcpAliases.has(mcpLc)) {
			warnIgnored(flat, mcp, "alias name is already taken by another extension's tool");
			continue;
		}
		if (ownedFor !== undefined && lower(ownedFor) !== lower(flat)) {
			warnIgnored(flat, mcp, `alias is already registered for "${ownedFor}"`);
			continue;
		}
		validUserAliases.push([flat, mcp]);
		userOverrides.set(lower(flat), mcp);
		overrideTargets.add(mcpLc);
		taken.add(mcpLc);
	}

	const registerAliasTool = (tool: ToolInfo, mcpName: string): void => {
		const mcpLc = lower(mcpName);
		const meta: AliasSourceMeta = {
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
		};
		if (registeredMcpAliases.has(mcpLc)) {
			// Re-register when the source tool's metadata changed (e.g. the source
			// extension re-registered it with a new schema from a lifecycle hook)
			// or when the exact alias casing changed (pi keys tools by exact name).
			const previous = aliasSourceMeta.get(mcpLc);
			if (
				previous &&
				previous.description === meta.description &&
				previous.parameters === meta.parameters &&
				previous.promptGuidelines === meta.promptGuidelines &&
				aliasExactNames.get(mcpLc) === mcpName
			) {
				return;
			}
		} else if (toolIndex.has(mcpLc)) {
			// Never shadow an existing tool (e.g. a real MCP tool from another extension).
			return;
		}
		// Pi keys tool registrations by EXACT name and auto-activates newly
		// introduced exact names, so a case-only alias change also counts as a
		// new registration for provenance tracking.
		const isNewExactName = aliasExactNames.get(mcpLc) !== mcpName;
		pi.registerTool({
			name: mcpName,
			label: `MCP ${tool.name}`,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
			renderResult(result, { expanded, isPartial }, theme, context) {
				return renderCompactAliasResult(result.content, { expanded, isPartial }, theme, context.showImages);
			},
			async execute() {
				// Managed alias calls are rewritten back to the flat tool name at
				// message_end before Pi resolves execution, so this stub only runs
				// if that rewrite was somehow bypassed.
				throw new Error(
					`Tool alias "${mcpName}" was invoked directly; pi-claude-code-use should have routed it to "${tool.name}".`,
				);
			},
		} as ToolRegistration);
		registeredMcpAliases.add(mcpLc);
		registeredAliasRoutes.set(mcpLc, tool.name);
		aliasSourceMeta.set(mcpLc, meta);
		aliasExactNames.set(mcpLc, mcpName);
		// Pi auto-activates newly registered tool NAMES (not same-name
		// re-registrations, which preserve activation). Track only new exact
		// names as auto-managed so syncAliasActivation can deactivate them when
		// OAuth is off or the flat source tool is inactive, without flipping the
		// provenance of a user-selected alias whose source schema merely changed.
		if (isNewExactName) {
			autoActivatedAliases.add(mcpName);
		}
	};

	const derivedPairs: ToolAliasPair[] = [];
	for (const tool of aliasable) {
		const flatLc = lower(tool.name);
		if (isDuplicateFlat(flatLc)) {
			console.warn(`[pi-claude-code-use] Not aliasing "${tool.name}": case-insensitive duplicate tool name`);
			continue;
		}

		const override = userOverrides.get(flatLc);
		if (override) {
			registerAliasTool(tool, override);
			continue; // Mapping comes from validUserAliases in refreshAliasMap.
		}
		if (disableAutoAlias) continue;

		// Reuse the previous derived assignment when we registered it; otherwise derive.
		let mcpName = aliasAssignments.get(flatLc);
		if (!mcpName || (!registeredMcpAliases.has(lower(mcpName)) && taken.has(lower(mcpName)))) {
			mcpName = reserveAliasName(deriveAliasBase(tool), taken);
		}
		taken.add(lower(mcpName));
		aliasAssignments.set(flatLc, mcpName);
		derivedPairs.push([tool.name, mcpName]);
		registerAliasTool(tool, mcpName);
	}

	refreshAliasMap(validUserAliases, derivedPairs);
}

/**
 * Synchronize MCP alias tool activation with the current model state.
 * When OAuth is active, auto-activate aliases for any active flat source tools.
 * When OAuth is inactive, remove auto-activated aliases (but preserve user-selected ones).
 */
function syncAliasActivation(pi: ExtensionAPI, enableAliases: boolean): void {
	const activeNames = pi.getActiveTools();
	const allNames = new Set(pi.getAllTools().map((t) => t.name));

	if (enableAliases) {
		// Determine which aliases should be active based on their flat counterpart being active
		const activeLc = new Set(activeNames.map(lower));
		const desiredAliases: string[] = [];
		for (const [flat, mcp] of FLAT_TO_MCP) {
			if (activeLc.has(flat) && allNames.has(mcp) && registeredMcpAliases.has(lower(mcp))) {
				desiredAliases.push(mcp);
			}
		}
		const desiredSet = new Set(desiredAliases);

		promoteKeptAliases(activeNames, desiredSet);

		// Find registered aliases currently in the active list
		const activeRegistered = activeNames.filter((n) => registeredMcpAliases.has(lower(n)) && allNames.has(n));

		// Per-alias provenance: an alias is "user-selected" if it's active and was NOT
		// auto-activated by us. Only preserve those; auto-activated aliases get re-derived
		// from the desired set each sync.
		const preserved = activeRegistered.filter((n) => !autoActivatedAliases.has(n));

		// Build result: non-alias tools + preserved user aliases + desired aliases
		const nonAlias = activeNames.filter((n) => !registeredMcpAliases.has(lower(n)));
		const next = Array.from(new Set([...nonAlias, ...preserved, ...desiredAliases]));

		// Update auto-activation tracking: aliases we added this sync that weren't user-preserved
		const preservedSet = new Set(preserved);
		autoActivatedAliases.clear();
		for (const name of desiredAliases) {
			if (!preservedSet.has(name)) {
				autoActivatedAliases.add(name);
			}
		}

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
		}
		// Record the managed state even when nothing changed (pi may have
		// auto-activated a fresh alias, making the first sync a no-op). The
		// promote-to-user-selected logic needs this baseline to recognize a
		// user's later picker changes.
		lastManagedToolList = [...next];
	} else {
		// A user may have removed a flat tool while keeping its alias and then
		// switched away from OAuth before another enabled sync ran; honor that
		// choice here too before pruning.
		promoteKeptAliases(activeNames, new Set());

		// Remove only auto-activated aliases; user-selected ones are preserved
		const next = activeNames.filter((n) => !autoActivatedAliases.has(n));
		autoActivatedAliases.clear();

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
			lastManagedToolList = [...next];
		} else {
			lastManagedToolList = undefined;
		}
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default async function piClaudeCodeUse(pi: ExtensionAPI): Promise<void> {
	// Display-only prose un-cloaking. The API is new in pi 0.84 while the peer
	// floor is 0.77, so feature-detect instead of raising the floor.
	if (typeof pi.registerMarkdownTransformer === "function") {
		pi.registerMarkdownTransformer(unaliasDisplayedProse);
	}

	pi.on("session_start", async (_event, ctx) => {
		registerMcpAliases(pi, { cwd: ctx.cwd });
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		registerMcpAliases(pi, { cwd: ctx.cwd });
		const model = ctx.model;
		const isOAuth = model?.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model);
		syncAliasActivation(pi, isOAuth);
	});

	// MCP alias → flat canonical name before the agent loop resolves the tool.
	pi.on("message_end", async (event, _ctx) => {
		const rewritten = unaliasToolCalls(event.message);
		if (!rewritten) return undefined;
		return { message: rewritten as typeof event.message };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(model)) {
			return undefined;
		}
		if (!isPlainObject(event.payload)) {
			return undefined;
		}

		// Catch tools registered by other extensions' before_agent_start handlers
		// that ran AFTER ours (extension order), so their aliases exist on the
		// first turn instead of the second. filterAndRemapTools renames flat tools
		// to registered aliases even before activation catches up.
		try {
			registerMcpAliases(pi, { cwd: typeof ctx.cwd === "string" ? ctx.cwd : undefined });
		} catch {
			// Alias refresh must never break the actual request.
		}

		writeDebugLog({ stage: "before", payload: event.payload });
		const disableFilter = process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER === "1";
		const transformed = transformPayload(event.payload as Record<string, unknown>, disableFilter);
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
	getLastManagedToolList: () => lastManagedToolList,
	isPlainObject,
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
		lastManagedToolList = v;
	},
	syncAliasActivation,
	transformPayload,
	unaliasDisplayedProse,
	unaliasToolCalls,
};
