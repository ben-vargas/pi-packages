import { describe, expect, it } from "vitest";
import {
	buildProgressBar,
	formatTimeRemaining,
	getFallbackModels,
	getQuotaSystemLabel,
	getUsageColor,
	hasVisibleQuotaBucket,
	parsePrice,
	shouldDisplaySubscriptionQuota,
} from "../extensions/index.js";

describe("pi-synthetic-provider helpers", () => {
	it("parses prices", () => {
		expect(parsePrice(undefined)).toBe(0);
		expect(parsePrice("$0.00000055")).toBeCloseTo(0.55, 6);
		expect(parsePrice("$1.20")).toBeCloseTo(1.2, 6);
	});

	it("provides fallback models", () => {
		const models = getFallbackModels();
		const modelIds = models.map((model) => model.id);

		expect(modelIds).toEqual([
			"syn:large:text",
			"syn:small:text",
			"syn:large:vision",
			"syn:small:vision",
			"hf:openai/gpt-oss-120b",
			"hf:zai-org/GLM-5.2",
			"hf:moonshotai/Kimi-K3",
			"hf:Qwen/Qwen3.6-27B",
			"hf:MiniMaxAI/MiniMax-M3",
			"hf:zai-org/GLM-4.7-Flash",
			"hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
		]);

		for (const staleId of [
			"hf:zai-org/GLM-5.1",
			"hf:moonshotai/Kimi-K2.6",
			"hf:moonshotai/Kimi-K2.7-Code",
			"hf:zai-org/GLM-4.7",
			"hf:Qwen/Qwen3.5-397B-A17B",
		]) {
			expect(modelIds).not.toContain(staleId);
		}

		expect(models.find((model) => model.id === "hf:openai/gpt-oss-120b")).toMatchObject({
			reasoning: true,
			maxTokens: 65536,
		});
		expect(models.find((model) => model.id === "hf:MiniMaxAI/MiniMax-M3")).toMatchObject({
			contextWindow: 262144,
		});
		expect(models.find((model) => model.id === "hf:moonshotai/Kimi-K3")).toMatchObject({
			contextWindow: 524288,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.45 },
		});
		// syn:large:vision was re-pointed from Kimi K2.7-Code to Kimi K3.
		expect(models.find((model) => model.id === "syn:large:vision")).toMatchObject({
			contextWindow: 524288,
			cost: { input: 3, output: 15, cacheRead: 0.45 },
		});
	});

	it("matches the live catalog price for every fallback model", () => {
		// Exact expected values, not merely cacheRead < input: the bug being guarded
		// against set cacheRead equal to input, and a too-low wrong value would still
		// satisfy an inequality. Sourced from input_cache_reads in the 2026-07-28
		// authenticated catalog pull.
		const expected: Record<string, { input: number; output: number; cacheRead: number }> = {
			"syn:large:text": { input: 1, output: 3, cacheRead: 0.16 },
			"syn:small:text": { input: 0.1, output: 0.5, cacheRead: 0.02 },
			"syn:large:vision": { input: 3, output: 15, cacheRead: 0.45 },
			"syn:small:vision": { input: 0.45, output: 3.6, cacheRead: 0.09 },
			"hf:openai/gpt-oss-120b": { input: 0.1, output: 0.1, cacheRead: 0.02 },
			"hf:zai-org/GLM-5.2": { input: 1, output: 3, cacheRead: 0.16 },
			"hf:moonshotai/Kimi-K3": { input: 3, output: 15, cacheRead: 0.45 },
			"hf:Qwen/Qwen3.6-27B": { input: 0.45, output: 3.6, cacheRead: 0.09 },
			"hf:MiniMaxAI/MiniMax-M3": { input: 0.6, output: 1.2, cacheRead: 0.12 },
			"hf:zai-org/GLM-4.7-Flash": { input: 0.1, output: 0.5, cacheRead: 0.02 },
			"hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4": { input: 0.3, output: 1, cacheRead: 0.06 },
		};

		const models = getFallbackModels();
		expect(models.map((model) => model.id).sort()).toEqual(Object.keys(expected).sort());

		for (const model of models) {
			expect({ id: model.id, ...model.cost, cacheWrite: undefined }).toMatchObject({
				id: model.id,
				...expected[model.id],
			});
			expect(model.cost.cacheWrite).toBe(0);
			expect(model.cost.cacheRead).toBeLessThan(model.cost.input);
		}
	});

	it("enables reasoning effort for all reasoning models in fallback models", () => {
		const models = getFallbackModels();
		const reasoningModels = [
			["hf:zai-org/GLM-5.2", { off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: "max" }],
			[
				"hf:zai-org/GLM-4.7-Flash",
				{ off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: null },
			],
			[
				"hf:moonshotai/Kimi-K3",
				{ off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: "max" },
			],
			["hf:Qwen/Qwen3.6-27B", { off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: "max" }],
			["hf:MiniMaxAI/MiniMax-M3", { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null }],
			[
				"hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
				{ off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: null },
			],
		] as const;

		for (const [id, thinkingLevelMap] of reasoningModels) {
			const model = models.find((m) => m.id === id);
			expect(model).toMatchObject({ reasoning: true, compat: { supportsReasoningEffort: true } });
			expect(model?.thinkingLevelMap).toEqual(thinkingLevelMap);
		}

		// Non-reasoning fallbacks keep default compat
		for (const id of [
			"syn:large:text",
			"syn:small:text",
			"syn:large:vision",
			"syn:small:vision",
			"hf:openai/gpt-oss-120b",
		]) {
			const model = models.find((m) => m.id === id);
			expect(model).toMatchObject({ compat: { supportsReasoningEffort: false } });
			expect(model?.thinkingLevelMap).toBeUndefined();
		}
	});
});

describe("quota helpers", () => {
	describe("buildProgressBar", () => {
		it("returns 0% for no usage", () => {
			const { bar, percent } = buildProgressBar(0, 135, 10);
			expect(percent).toBe(0);
			expect(bar).toBe("░".repeat(10));
		});

		it("returns 100% when fully used", () => {
			const { bar, percent } = buildProgressBar(135, 135, 10);
			expect(percent).toBe(100);
			expect(bar).toBe("█".repeat(10));
		});

		it("returns correct percentage for partial usage", () => {
			const { bar, percent } = buildProgressBar(67.5, 135, 10);
			expect(percent).toBeCloseTo(50, 1);
			expect(bar).toBe("█".repeat(5) + "░".repeat(5));
		});

		it("clamps at 100% when over limit", () => {
			const { percent } = buildProgressBar(200, 135, 10);
			expect(percent).toBe(100);
		});

		it("handles zero limit gracefully", () => {
			const { percent } = buildProgressBar(10, 0, 10);
			expect(percent).toBe(0);
		});
	});

	describe("getUsageColor", () => {
		it("returns success for low usage", () => {
			expect(getUsageColor(0)).toBe("success");
			expect(getUsageColor(30)).toBe("success");
			expect(getUsageColor(59)).toBe("success");
		});

		it("returns warning for moderate usage", () => {
			expect(getUsageColor(60)).toBe("warning");
			expect(getUsageColor(75)).toBe("warning");
			expect(getUsageColor(84)).toBe("warning");
		});

		it("returns error for high usage", () => {
			expect(getUsageColor(85)).toBe("error");
			expect(getUsageColor(95)).toBe("error");
			expect(getUsageColor(100)).toBe("error");
		});
	});

	describe("formatTimeRemaining", () => {
		it("formats hours and minutes", () => {
			const future = new Date(Date.now() + 2 * 60 * 60_000 + 14 * 60_000).toISOString();
			const result = formatTimeRemaining(future);
			expect(result).toMatch(/^2h 1[34]m$/);
		});

		it("formats minutes only", () => {
			const future = new Date(Date.now() + 45 * 60_000).toISOString();
			const result = formatTimeRemaining(future);
			expect(result).toMatch(/^4[45]m$/);
		});

		it("returns 'now' for past dates", () => {
			const past = new Date(Date.now() - 60_000).toISOString();
			expect(formatTimeRemaining(past)).toBe("now");
		});

		it("returns '< 1m' for very short durations", () => {
			const nearFuture = new Date(Date.now() + 30_000).toISOString();
			expect(formatTimeRemaining(nearFuture)).toBe("< 1m");
		});
	});

	describe("hasVisibleQuotaBucket", () => {
		it("returns false for missing buckets", () => {
			expect(hasVisibleQuotaBucket(undefined)).toBe(false);
		});

		it("returns false for disabled zero buckets", () => {
			expect(
				hasVisibleQuotaBucket({
					limit: 0,
					requests: 0,
					renewsAt: new Date(Date.now() + 60_000).toISOString(),
				}),
			).toBe(false);
		});

		it("returns true when the bucket has a limit", () => {
			expect(
				hasVisibleQuotaBucket({
					limit: 10,
					requests: 0,
					renewsAt: new Date(Date.now() + 60_000).toISOString(),
				}),
			).toBe(true);
		});
	});

	describe("getQuotaSystemLabel", () => {
		it("detects classic quota systems", () => {
			expect(
				getQuotaSystemLabel({
					subscription: {
						limit: 100,
						requests: 10,
						renewsAt: new Date(Date.now() + 60_000).toISOString(),
					},
				}),
			).toBe("Classic quota system");
		});

		it("detects enhanced quota systems", () => {
			expect(
				getQuotaSystemLabel({
					weeklyTokenLimit: {
						nextRegenAt: new Date(Date.now() + 60_000).toISOString(),
						percentRemaining: 75,
					},
				}),
			).toBe("Enhanced quota system");
		});

		it("detects hybrid quota systems", () => {
			expect(
				getQuotaSystemLabel({
					subscription: {
						limit: 100,
						requests: 10,
						renewsAt: new Date(Date.now() + 60_000).toISOString(),
					},
					rollingFiveHourLimit: {
						nextTickAt: new Date(Date.now() + 60_000).toISOString(),
						tickPercent: 0.05,
						remaining: 90,
						max: 100,
						limited: false,
					},
				}),
			).toBe("Hybrid quota system");
		});
	});

	describe("shouldDisplaySubscriptionQuota", () => {
		it("shows subscription quota for classic users", () => {
			expect(
				shouldDisplaySubscriptionQuota({
					subscription: {
						limit: 100,
						requests: 10,
						renewsAt: new Date(Date.now() + 60_000).toISOString(),
					},
				}),
			).toBe(true);
		});

		it("hides subscription quota for hybrid users", () => {
			expect(
				shouldDisplaySubscriptionQuota({
					subscription: {
						limit: 600,
						requests: 0,
						renewsAt: new Date(Date.now() + 60_000).toISOString(),
					},
					rollingFiveHourLimit: {
						nextTickAt: new Date(Date.now() + 60_000).toISOString(),
						tickPercent: 0.05,
						remaining: 600,
						max: 600,
						limited: false,
					},
				}),
			).toBe(false);
		});
	});
});
