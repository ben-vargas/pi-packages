import { keyHint, keyText, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, getImageDimensions, imageFallback, Text } from "@earendil-works/pi-tui";
import { lower } from "../shared.js";
import { MCP_TO_FLAT, registeredAliasRoutes, registeredMcpAliases } from "./state.js";

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
export function sanitizeResultText(text: string): string {
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
export function truncateCodePoints(text: string, maxCodePoints: number): { text: string; truncated: boolean } {
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

export function renderCompactAliasResult(
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

export function unaliasDisplayedProse(markdown: string, context: MarkdownTransformContext): string {
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
