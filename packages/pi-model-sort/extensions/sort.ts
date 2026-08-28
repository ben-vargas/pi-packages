/**
 * Shared constants, types, and utilities for pi-model-sort.
 */

import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

/** Default config file name (placed in ~/.pi/agent/extensions/). */
export const CONFIG_FILENAME = "pi-model-sort.json";

/** Thinking levels supported by pi. Mirrors ThinkingLevel from pi-agent-core. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** All valid thinking levels, ascending. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Type guard for ThinkingLevel. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface ModelSortConfig {
	/** Map of "provider/modelId" → last-used Unix timestamp (ms). */
	lastUsed: Record<string, number>;
	/** Map of "provider/modelId" → last-used thinking level. */
	thinking: Record<string, ThinkingLevel>;
}

/**
 * Parse a raw config file payload into a ModelSortConfig, dropping malformed
 * entries. Unknown fields are ignored; missing fields default to empty maps.
 */
export function parseConfig(raw: unknown): ModelSortConfig {
	const config: ModelSortConfig = { lastUsed: {}, thinking: {} };
	if (typeof raw !== "object" || raw === null) return config;

	const obj = raw as Record<string, unknown>;
	if (typeof obj.lastUsed === "object" && obj.lastUsed !== null) {
		for (const [key, value] of Object.entries(obj.lastUsed)) {
			if (typeof value === "number" && Number.isFinite(value)) {
				config.lastUsed[key] = value;
			}
		}
	}
	if (typeof obj.thinking === "object" && obj.thinking !== null) {
		for (const [key, value] of Object.entries(obj.thinking)) {
			if (isThinkingLevel(value)) {
				config.thinking[key] = value;
			}
		}
	}
	return config;
}

/** Parse a model key into [provider, modelId]. Returns undefined if malformed. */
export function parseModelKey(key: string): [provider: string, modelId: string] | undefined {
	const idx = key.indexOf("/");
	if (idx === -1) return undefined;
	return [key.substring(0, idx), key.substring(idx + 1)];
}

/** Build a stable model key from provider and model id. */
export function buildModelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/** Reasons pi reports for session_start events. */
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/**
 * Whether the session branch produces context messages — pi core's own
 * continuation predicate (`buildSessionContext().messages.length > 0`).
 *
 * pi seeds every NEW session with `model_change` and `thinking_level_change`
 * entries during `createAgentSession` — BEFORE extensions are bound and
 * `session_start` fires (installed pi 0.84.3, dist/core/sdk.js:241-252) — so
 * raw branch length is always > 0 by the time extensions observe it. Context
 * messages come from more than literal `message` entries: pi's
 * `sessionEntryToContextMessages` also projects `custom_message`, non-empty
 * `branch_summary`, and `compaction` entries (dist/core/session-manager.js:
 * 162-188), so a summarized branch with no literal message still counts as
 * continued for core — and must for us too.
 */
export function hasContextMessages(entries: readonly SessionEntry[]): boolean {
	return entries.flatMap(sessionEntryToContextMessages).length > 0;
}

/**
 * Whether the MRU (most recently used) startup override should apply for a
 * session start.
 *
 * Fresh starts and `/new` switch to the most recently used model. A continued
 * session (`pi -c`, `--session`) has already restored the model saved in its
 * session file — the override is skipped so global MRU does not clobber it.
 * `/resume` and forked sessions keep the session's own model as well.
 *
 * @param reason session_start reason reported by pi
 * @param hasSessionMessages whether the session branch produces context messages
 */
export function shouldApplyMruOverride(reason: SessionStartReason, hasSessionMessages: boolean): boolean {
	if (reason === "startup" && hasSessionMessages) return false;
	return reason === "startup" || reason === "new";
}

/**
 * Whether the model pi restored for this session start should be recorded as
 * last-used. Pi 0.84.3 restores a continued session's model during
 * construction without emitting `model_select`, so recency would otherwise
 * never update for continuations.
 *
 * Only starts of a session that already carries context count (continued
 * `startup`, `resume`, `fork`). "new" is excluded — a fresh session has no
 * restored model even when a `setup` hook appended messages before
 * `session_start`. "reload" is excluded — it rebuilds the extension runner
 * around the same live session without a construction-time restore, and the
 * active model was already recorded when it became active.
 *
 * @param reason session_start reason reported by pi
 * @param hasSessionMessages whether the session branch produces context messages
 */
export function shouldTimestampRestoredModel(reason: SessionStartReason, hasSessionMessages: boolean): boolean {
	if (!hasSessionMessages) return false;
	return reason === "startup" || reason === "resume" || reason === "fork";
}

/**
 * Sort an array of models (or model-like objects) by last-usage recency.
 *
 * Sort order:
 *   1. Current model first (if currentModelKey is provided)
 *   2. Most recently used (highest timestamp) first
 *   3. Provider name alphabetically
 *   4. Model id alphabetically
 *
 * Models with no recorded usage get timestamp 0 (sorted last).
 */
export function sortByLastUsed<T extends { provider: string; id: string }>(
	items: T[],
	lastUsed: Record<string, number>,
	currentModelKey: string | null,
): T[] {
	const sorted = [...items];
	sorted.sort((a, b) => {
		const aKey = buildModelKey(a.provider, a.id);
		const bKey = buildModelKey(b.provider, b.id);

		if (currentModelKey !== null) {
			const aIsCurrent = aKey === currentModelKey;
			const bIsCurrent = bKey === currentModelKey;
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
		}

		const aLast = lastUsed[aKey] ?? 0;
		const bLast = lastUsed[bKey] ?? 0;
		if (aLast !== bLast) return bLast - aLast;

		return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
	});
	return sorted;
}

/**
 * MRU model lookup — finds the most recently used model that exists in the
 * registry and has auth configured. Returns undefined if no usable model is
 * found. `find`/`hasConfiguredAuth` match the pi 0.84.3 ModelRegistry
 * extension facade surface.
 */
export function findMruModel(
	lastUsed: Record<string, number>,
	registry: { find(provider: string, modelId: string): unknown; hasConfiguredAuth(model: unknown): boolean },
): unknown | undefined {
	const sorted = Object.entries(lastUsed).sort(([, a], [, b]) => b - a);
	for (const [key] of sorted) {
		const parsed = parseModelKey(key);
		if (!parsed) continue;
		const [provider, modelId] = parsed;
		const model = registry.find(provider, modelId);
		if (model && registry.hasConfiguredAuth(model)) {
			return model;
		}
	}
	return undefined;
}

/**
 * Per-model thinking-level memory.
 *
 * Pi keeps one global thinking level: on every model switch it carries the
 * current level over and clamps it to the new model's capabilities, so each
 * model needs manual re-adjustment. This tracker records the last level used
 * per model and computes which level to restore on switch.
 *
 * Attribution relies on pi's event ordering: setModel/cycle swap the model
 * and re-clamp the level (emitting thinking_level_select) *before* emitting
 * model_select. So when a thinking_level_select arrives whose current model
 * no longer matches the tracked active model, the change belongs to a switch:
 * previousLevel is the final level of the model being left (recorded), while
 * the new level is inherited rather than chosen (not recorded).
 */
export interface ThinkingTrackerState {
	/** Persisted map of "provider/modelId" → last-used thinking level. */
	thinking: Record<string, ThinkingLevel>;
	/** Key of the model last accounted for (session start or last model_select). */
	activeKey: string | null;
	/** Whether a switch-time re-clamp fired since the last model_select. */
	sawSwitchClamp: boolean;
}

export function createThinkingTracker(): ThinkingTrackerState {
	return { thinking: {}, activeKey: null, sawSwitchClamp: false };
}

function recordLevel(state: ThinkingTrackerState, key: string, level: ThinkingLevel): boolean {
	if (state.thinking[key] === level) return false;
	state.thinking[key] = level;
	return true;
}

/**
 * Record a thinking_level_select event. currentKey is the model pi reports as
 * active at event time. Returns true when the thinking map changed.
 */
export function recordThinkingSelect(
	state: ThinkingTrackerState,
	currentKey: string | null,
	level: ThinkingLevel,
	previousLevel: ThinkingLevel,
): boolean {
	if (currentKey !== null && state.activeKey !== null && currentKey !== state.activeKey) {
		state.sawSwitchClamp = true;
		return recordLevel(state, state.activeKey, previousLevel);
	}
	const key = currentKey ?? state.activeKey;
	if (key === null) return false;
	return recordLevel(state, key, level);
}

/**
 * Account for a model_select event and decide which level to restore, if any.
 * currentLevel is the session's thinking level after pi's switch-time clamp.
 * Sets activeKey to newKey — callers must apply the returned level afterwards
 * (via pi.setThinkingLevel) so the emitted thinking_level_select attributes
 * the effective, possibly further-clamped level to the new model.
 */
export function handleModelSelect(
	state: ThinkingTrackerState,
	newKey: string,
	previousKey: string | null,
	currentLevel: ThinkingLevel,
): ThinkingLevel | null {
	// No re-clamp during the switch means the level carried over unchanged, so
	// currentLevel is also the previous model's final level. When a re-clamp did
	// fire, recordThinkingSelect already stored the previous model's level.
	if (previousKey !== null && !state.sawSwitchClamp) {
		recordLevel(state, previousKey, currentLevel);
	}
	state.sawSwitchClamp = false;
	state.activeKey = newKey;

	const remembered = state.thinking[newKey];
	if (remembered === undefined || remembered === currentLevel) return null;
	return remembered;
}
