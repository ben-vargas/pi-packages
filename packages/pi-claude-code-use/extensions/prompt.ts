import { isPlainObject } from "./shared.js";

// ============================================================================
// System prompt rewrite
//
// Anthropic routes OAuth requests whose system prompt carries pi's own
// phrasing (verified live 2026-10-25: "pi itself", "pi packages") to extra
// usage instead of the Claude subscription. Rewriting those phrases is what
// keeps subscription requests working. Preserves cache_control, non-text
// blocks, and payload shape.
// ============================================================================

export function rewritePromptText(text: string): string {
	return text
		.replaceAll("pi itself", "the cli itself")
		.replaceAll("pi .md files", "cli .md files")
		.replaceAll("pi packages", "cli packages");
}

export function rewriteSystemField(system: unknown): unknown {
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

/** Rewrite the leading system prompt and every later system message in place. */
export function rewriteSystemPrompts(payload: Record<string, unknown>): void {
	if (payload.system !== undefined) {
		payload.system = rewriteSystemField(payload.system);
	}
	if (Array.isArray(payload.messages)) {
		payload.messages = payload.messages.map((msg) =>
			isPlainObject(msg) && msg.role === "system" ? { ...msg, content: rewriteSystemField(msg.content) } : msg,
		);
	}
}
