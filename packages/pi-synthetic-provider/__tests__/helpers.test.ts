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
			"hf:moonshotai/Kimi-K2.7-Code",
			"hf:Qwen/Qwen3.6-27B",
			"hf:MiniMaxAI/MiniMax-M3",
			"hf:zai-org/GLM-4.7-Flash",
			"hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
		]);

		for (const staleId of [
			"hf:zai-org/GLM-5.1",
			"hf:moonshotai/Kimi-K2.6",
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
	});

	it("enables reasoning effort for all reasoning models in fallback models", () => {
		const models = getFallbackModels();

		// GLM-5.2
		const glm = models.find((model) => model.id === "hf:zai-org/GLM-5.2");
		expect(glm).toMatchObject({ compat: { supportsReasoningEffort: true } });
		expect(glm?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "medium",
		});

		// Other reasoning models should also have effort enabled
		for (const id of [
			"hf:zai-org/GLM-4.7-Flash",
			"hf:moonshotai/Kimi-K2.7-Code",
			"hf:Qwen/Qwen3.6-27B",
			"hf:MiniMaxAI/MiniMax-M3",
			"hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
		]) {
			const model = models.find((m) => m.id === id);
			expect(model).toMatchObject({ compat: { supportsReasoningEffort: true } });
			expect(model?.thinkingLevelMap).toBeDefined();
		}

		// Non-reasoning fallbacks keep default compat
		for (const id of ["syn:large:text", "syn:small:text", "syn:large:vision", "syn:small:vision", "hf:openai/gpt-oss-120b"]) {
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
