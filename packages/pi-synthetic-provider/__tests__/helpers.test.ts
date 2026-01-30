import { describe, expect, it } from "vitest";
import { getFallbackModels, parsePrice } from "../extensions/index.js";

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
