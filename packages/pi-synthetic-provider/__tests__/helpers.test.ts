import { describe, expect, it } from "vitest";
import {
	buildProgressBar,
	formatTimeRemaining,
	getFallbackModels,
	getUsageColor,
	parsePrice,
} from "../extensions/index.js";

describe("pi-synthetic-provider helpers", () => {
	it("parses prices", () => {
		expect(parsePrice(undefined)).toBe(0);
		expect(parsePrice("$0.00000055")).toBeCloseTo(0.55, 6);
		expect(parsePrice("$1.20")).toBeCloseTo(1.2, 6);
	});

	it("provides fallback models", () => {
		const models = getFallbackModels();
		expect(models.length).toBeGreaterThan(0);
		expect(models.some((model) => model.id.includes("Kimi-K2.5"))).toBe(true);
		for (const model of models.slice(0, 5)) {
			expect(model.id).toEqual(expect.any(String));
			expect(model.name).toEqual(expect.any(String));
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
});
