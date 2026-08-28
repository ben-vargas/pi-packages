import { describe, expect, it } from "vitest";
import {
	buildModelKey,
	findMruModel,
	hasContextMessages,
	parseConfig,
	parseModelKey,
	shouldApplyMruOverride,
	shouldTimestampRestoredModel,
	sortByLastUsed,
} from "../extensions/sort.js";

describe("buildModelKey", () => {
	it("builds a key from provider and model id", () => {
		expect(buildModelKey("anthropic", "claude-sonnet-4-20250514")).toBe("anthropic/claude-sonnet-4-20250514");
	});

	it("builds a key for openai provider", () => {
		expect(buildModelKey("openai", "gpt-4o")).toBe("openai/gpt-4o");
	});
});

describe("parseModelKey", () => {
	it("parses a simple provider/modelId key", () => {
		expect(parseModelKey("anthropic/claude-sonnet-4")).toEqual(["anthropic", "claude-sonnet-4"]);
	});

	it("parses a key where modelId contains slashes", () => {
		expect(parseModelKey("openrouter/anthropic/claude-sonnet-4")).toEqual(["openrouter", "anthropic/claude-sonnet-4"]);
	});

	it("returns undefined for keys without a slash", () => {
		expect(parseModelKey("noprovider")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(parseModelKey("")).toBeUndefined();
	});

	it("round-trips through buildModelKey", () => {
		const provider = "openrouter";
		const modelId = "anthropic/claude-sonnet-4";
		const key = buildModelKey(provider, modelId);
		expect(parseModelKey(key)).toEqual([provider, modelId]);
	});
});

describe("hasContextMessages", () => {
	// Entry shapes mirror pi 0.84.3 session files: a NEW session is seeded
	// with model_change + thinking_level_change before session_start, and
	// pi's sessionEntryToContextMessages projects more than literal messages
	// into context (custom_message, non-empty branch_summary, compaction).
	// Fixtures use minimal valid shapes for each entry type.
	const messageEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	} as never;
	const customMessageEntry = {
		type: "custom_message",
		id: "c1",
		parentId: null,
		customType: "note",
		content: [{ type: "text", text: "note" }],
	} as never;
	const branchSummaryEntry = {
		type: "branch_summary",
		id: "b1",
		parentId: null,
		summary: "summary text",
		fromId: null,
	} as never;
	const emptyBranchSummaryEntry = {
		type: "branch_summary",
		id: "b2",
		parentId: null,
		summary: "",
		fromId: null,
	} as never;
	const compactionEntry = {
		type: "compaction",
		id: "k1",
		parentId: null,
		summary: "compacted",
		firstKeptEntryId: null,
	} as never;
	const plainCustomEntry = { type: "custom", id: "d1", parentId: null, entryType: "note" } as never;
	const freshSeed = [{ type: "model_change", id: "s1", parentId: null } as never];

	it("treats a freshly seeded session (model/thinking entries only) as not continued", () => {
		expect(hasContextMessages(freshSeed)).toBe(false);
	});

	it("treats an empty branch as not continued", () => {
		expect(hasContextMessages([])).toBe(false);
	});

	it("treats a literal message entry as continued", () => {
		expect(hasContextMessages([messageEntry])).toBe(true);
	});

	it("treats a context-only summarized branch (no literal message) as continued", () => {
		// Reachable via tree navigation + branchWithSummary on a pre-message
		// parent: model_change -> thinking_level_change -> branch_summary.
		expect(hasContextMessages([branchSummaryEntry])).toBe(true);
	});

	it("treats a compaction-only branch as continued", () => {
		expect(hasContextMessages([compactionEntry])).toBe(true);
	});

	it("treats a custom_message entry as continued", () => {
		expect(hasContextMessages([customMessageEntry])).toBe(true);
	});

	it("ignores display-only entries (plain custom) and empty summaries", () => {
		expect(hasContextMessages([plainCustomEntry, emptyBranchSummaryEntry])).toBe(false);
	});
});

describe("shouldTimestampRestoredModel", () => {
	it("timestamps continued startup, resume, and context-bearing fork", () => {
		expect(shouldTimestampRestoredModel("startup", true)).toBe(true);
		expect(shouldTimestampRestoredModel("resume", true)).toBe(true);
		expect(shouldTimestampRestoredModel("fork", true)).toBe(true);
	});

	it("never timestamps fresh new sessions, even setup-populated ones", () => {
		expect(shouldTimestampRestoredModel("new", true)).toBe(false);
	});

	it("never timestamps reload", () => {
		expect(shouldTimestampRestoredModel("reload", true)).toBe(false);
	});

	it("never timestamps context-free starts of any reason", () => {
		for (const reason of ["startup", "new", "resume", "fork", "reload"] as const) {
			expect(shouldTimestampRestoredModel(reason, false)).toBe(false);
		}
	});
});

describe("findMruModel", () => {
	const registryFor = (models: Record<string, { auth: boolean }>) => ({
		find: (provider: string, modelId: string) => {
			const model = models[`${provider}/${modelId}`];
			return model ? { provider, id: modelId } : undefined;
		},
		hasConfiguredAuth: (model: unknown) => {
			const key = `${(model as { provider: string }).provider}/${(model as { id: string }).id}`;
			return models[key]?.auth ?? false;
		},
	});

	it("returns the most recently used model that exists and has auth", () => {
		const registry = registryFor({
			"anthropic/claude-sonnet-4": { auth: true },
			"openai/gpt-4o": { auth: true },
		});
		const model = findMruModel({ "openai/gpt-4o": 100, "anthropic/claude-sonnet-4": 200 }, registry) as {
			provider: string;
			id: string;
		};
		expect(`${model.provider}/${model.id}`).toBe("anthropic/claude-sonnet-4");
	});

	it("skips unauthenticated or missing MRU entries and falls through", () => {
		const registry = registryFor({
			"anthropic/claude-sonnet-4": { auth: false },
			"openai/gpt-4o": { auth: true },
		});
		const model = findMruModel(
			{ "openai/gpt-4o": 100, "anthropic/claude-sonnet-4": 200, "google/gone": 300 },
			registry,
		) as { provider: string; id: string };
		expect(`${model.provider}/${model.id}`).toBe("openai/gpt-4o");
	});

	it("returns undefined when no usable model exists", () => {
		const registry = registryFor({ "anthropic/claude-sonnet-4": { auth: false } });
		expect(findMruModel({ "anthropic/claude-sonnet-4": 100 }, registry)).toBeUndefined();
	});

	it("skips malformed keys", () => {
		const registry = registryFor({ "openai/gpt-4o": { auth: true } });
		const model = findMruModel({ noprovider: 500, "openai/gpt-4o": 100 }, registry) as {
			provider: string;
			id: string;
		};
		expect(`${model.provider}/${model.id}`).toBe("openai/gpt-4o");
	});
});

describe("parseConfig", () => {
	it("parses a well-formed config", () => {
		const config = parseConfig({
			lastUsed: { "openai/gpt-4o": 1717000000000 },
			thinking: { "openai/gpt-4o": "high" },
		});
		expect(config).toEqual({
			lastUsed: { "openai/gpt-4o": 1717000000000 },
			thinking: { "openai/gpt-4o": "high" },
		});
	});

	it("drops malformed entries and defaults missing fields", () => {
		const config = parseConfig({
			lastUsed: { "openai/gpt-4o": "not-a-number", "anthropic/claude": Number.NaN, "xai/grok": 5 },
			thinking: { "openai/gpt-4o": "ultra-mega", "anthropic/claude": "max" },
		});
		expect(config.lastUsed).toEqual({ "xai/grok": 5 });
		expect(config.thinking).toEqual({ "anthropic/claude": "max" });
	});

	it("returns empty maps for non-object payloads", () => {
		expect(parseConfig(null)).toEqual({ lastUsed: {}, thinking: {} });
		expect(parseConfig("junk")).toEqual({ lastUsed: {}, thinking: {} });
	});
});

describe("shouldApplyMruOverride", () => {
	it("applies on a fresh startup with no message entries", () => {
		expect(shouldApplyMruOverride("startup", false)).toBe(true);
	});

	it("applies on new sessions", () => {
		expect(shouldApplyMruOverride("new", false)).toBe(true);
	});

	it("skips continued sessions at startup (pi -c, --session)", () => {
		expect(shouldApplyMruOverride("startup", true)).toBe(false);
	});

	it("skips resume, reload, and fork regardless of message entries", () => {
		expect(shouldApplyMruOverride("resume", false)).toBe(false);
		expect(shouldApplyMruOverride("resume", true)).toBe(false);
		expect(shouldApplyMruOverride("reload", false)).toBe(false);
		expect(shouldApplyMruOverride("fork", false)).toBe(false);
	});
});

describe("sortByLastUsed", () => {
	const models = [
		{ provider: "anthropic", id: "claude-opus-4" },
		{ provider: "anthropic", id: "claude-sonnet-4" },
		{ provider: "openai", id: "gpt-4o" },
		{ provider: "google", id: "gemini-2.5-pro" },
		{ provider: "openai", id: "gpt-4.1" },
	];

	it("sorts by last-used descending when all have timestamps", () => {
		const lastUsed: Record<string, number> = {
			"google/gemini-2.5-pro": 300,
			"openai/gpt-4.1": 500,
			"openai/gpt-4o": 100,
			"anthropic/claude-sonnet-4": 400,
			"anthropic/claude-opus-4": 200,
		};

		const sorted = sortByLastUsed(models, lastUsed, null);
		expect(sorted.map((m) => buildModelKey(m.provider, m.id))).toEqual([
			"openai/gpt-4.1", // 500
			"anthropic/claude-sonnet-4", // 400
			"google/gemini-2.5-pro", // 300
			"anthropic/claude-opus-4", // 200
			"openai/gpt-4o", // 100
		]);
	});

	it("puts current model first regardless of timestamp", () => {
		const lastUsed: Record<string, number> = {
			"google/gemini-2.5-pro": 999, // Most recent
			"openai/gpt-4o": 500,
			"anthropic/claude-sonnet-4": 100, // Least recent — but current
		};

		const sorted = sortByLastUsed(models, lastUsed, "anthropic/claude-sonnet-4");
		expect(sorted[0]).toEqual({ provider: "anthropic", id: "claude-sonnet-4" });
	});

	it("treats missing entries as timestamp 0 (sorted last)", () => {
		const lastUsed: Record<string, number> = {
			"anthropic/claude-opus-4": 200,
			"openai/gpt-4o": 100,
		};

		const sorted = sortByLastUsed(models, lastUsed, null);
		// Models with timestamps come before those without
		const keys = sorted.map((m) => buildModelKey(m.provider, m.id));
		const withTimestamps = keys.filter((k) => k in lastUsed);
		const withoutTimestamps = keys.filter((k) => !(k in lastUsed));

		expect(withTimestamps).toEqual(["anthropic/claude-opus-4", "openai/gpt-4o"]);

		// Without-timestamp models fall back to provider/id alphabetical
		expect(withoutTimestamps).toEqual(["anthropic/claude-sonnet-4", "google/gemini-2.5-pro", "openai/gpt-4.1"]);
	});

	it("falls back to provider then id alphabetical for ties", () => {
		const lastUsed: Record<string, number> = {
			"anthropic/claude-opus-4": 200,
			"anthropic/claude-sonnet-4": 200, // Same timestamp as opus
		};

		const tied = [
			{ provider: "anthropic", id: "claude-sonnet-4" },
			{ provider: "anthropic", id: "claude-opus-4" },
		];

		const sorted = sortByLastUsed(tied, lastUsed, null);
		expect(sorted.map((m) => m.id)).toEqual(["claude-opus-4", "claude-sonnet-4"]);
	});

	it("handles empty lastUsed map gracefully", () => {
		const sorted = sortByLastUsed(models, {}, null);
		// Should fall back to provider then id alphabetical
		expect(sorted.map((m) => buildModelKey(m.provider, m.id))).toEqual([
			"anthropic/claude-opus-4",
			"anthropic/claude-sonnet-4",
			"google/gemini-2.5-pro",
			"openai/gpt-4.1",
			"openai/gpt-4o",
		]);
	});

	it("handles empty models array", () => {
		const sorted = sortByLastUsed([], {}, null);
		expect(sorted).toEqual([]);
	});

	it("does not mutate the input array", () => {
		const original = [...models];
		sortByLastUsed(
			models,
			{
				"openai/gpt-4o": 999,
			},
			null,
		);
		expect(models).toEqual(original);
	});

	it("sorts by provider alphabetically when no last-used data and no current model", () => {
		const crossProvider = [
			{ provider: "google", id: "gemini-2.5-pro" },
			{ provider: "openai", id: "gpt-4o" },
			{ provider: "anthropic", id: "claude-sonnet-4" },
		];

		const sorted = sortByLastUsed(crossProvider, {}, null);
		expect(sorted.map((m) => m.provider)).toEqual(["anthropic", "google", "openai"]);
	});
});
