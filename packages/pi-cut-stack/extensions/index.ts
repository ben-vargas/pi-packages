import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";

const DEFAULT_CUT_KEY = "alt+x";
const DEFAULT_POP_KEY = "alt+p";
const CUT_ACTION = "ext.pi-cut-stack.cut";
const POP_ACTION = "ext.pi-cut-stack.pop";

const DEFAULT_KEYS = {
	cut: [DEFAULT_CUT_KEY],
	pop: [DEFAULT_POP_KEY],
};

type ShortcutKeys = {
	cut: string[];
	pop: string[];
};

type KeybindingsConfig = Record<string, unknown>;

function getKeybindingsPath(): string {
	return join(getAgentDir(), "keybindings.json");
}

function readKeybindingsFile(filePath: string): KeybindingsConfig | null {
	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as KeybindingsConfig;
	} catch {
		return null;
	}
}

function normalizeKeyList(value: unknown, fallback: string[]): string[] {
	if (typeof value === "string") {
		const trimmed = value.trim().toLowerCase();
		return trimmed ? [trimmed] : fallback;
	}

	if (Array.isArray(value)) {
		const normalized = value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry.length > 0);
		return normalized.length > 0 ? normalized : fallback;
	}

	return fallback;
}

function resolveShortcutKeys(config: KeybindingsConfig | null | undefined): ShortcutKeys {
	return {
		cut: normalizeKeyList(config?.[CUT_ACTION], DEFAULT_KEYS.cut),
		pop: normalizeKeyList(config?.[POP_ACTION], DEFAULT_KEYS.pop),
	};
}

function loadShortcutKeys(): ShortcutKeys {
	return resolveShortcutKeys(readKeybindingsFile(getKeybindingsPath()));
}

function showEmptyStackToast(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify("Cut stack is empty", "info");
}

function handleCut(ctx: ExtensionContext, stack: string[]): void {
	if (!ctx.hasUI) return;
	const text = ctx.ui.getEditorText();
	if (!text) return;
	stack.push(text);
	ctx.ui.setEditorText("");
}

function handlePop(ctx: ExtensionContext, stack: string[]): void {
	if (!ctx.hasUI) return;
	const text = stack.pop();
	if (!text) {
		showEmptyStackToast(ctx);
		return;
	}
	const current = ctx.ui.getEditorText();
	ctx.ui.setEditorText(current + text);
}

export default function piCutStack(pi: ExtensionAPI): void {
	const stack: string[] = [];
	const keys = loadShortcutKeys();

	for (const key of keys.cut) {
		pi.registerShortcut(key as KeyId, {
			description: "Cut editor content to stack",
			handler: (ctx) => handleCut(ctx, stack),
		});
	}

	for (const key of keys.pop) {
		pi.registerShortcut(key as KeyId, {
			description: "Pop cut stack into editor",
			handler: (ctx) => handlePop(ctx, stack),
		});
	}
}

export const _test = {
	DEFAULT_KEYS,
	CUT_ACTION,
	POP_ACTION,
	getKeybindingsPath,
	readKeybindingsFile,
	resolveShortcutKeys,
	loadShortcutKeys,
};
