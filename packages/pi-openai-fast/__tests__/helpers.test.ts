import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { _test } from "../extensions/index.js";

function createContext(model: ExtensionContext["model"]): ExtensionContext {
	return {
		model,
	} as unknown as ExtensionContext;
}

describe("pi-openai-fast helpers", () => {
	it("parses persisted state only when it has a boolean active flag", () => {
		expect(_test.parseFastModeState({ active: true })).toEqual({ active: true });
		expect(_test.parseFastModeState({ active: false })).toEqual({ active: false });
		expect(_test.parseFastModeState({ active: "yes" })).toBeUndefined();
		expect(_test.parseFastModeState({})).toBeUndefined();
		expect(_test.parseFastModeState(null)).toBeUndefined();
	});

	it("recognizes supported fast models", () => {
		expect(_test.isFastSupportedModel({ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"])).toBe(true);
		expect(_test.isFastSupportedModel({ provider: "openai-codex", id: "gpt-5.4" } as ExtensionContext["model"])).toBe(
			true,
		);
		expect(
			_test.isFastSupportedModel({ provider: "anthropic", id: "claude-sonnet-4" } as ExtensionContext["model"]),
		).toBe(false);
		expect(_test.isFastSupportedModel(undefined)).toBe(false);
	});

	it("describes the current state and injects the priority service tier", () => {
		expect(_test.describeCurrentState(createContext(undefined), false)).toBe("Fast mode is off. Current model: none.");
		expect(
			_test.describeCurrentState(
				createContext({ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"]),
				true,
			),
		).toBe("Fast mode is on for openai/gpt-5.4.");
		expect(
			_test.describeCurrentState(
				createContext({ provider: "anthropic", id: "claude-sonnet-4" } as ExtensionContext["model"]),
				true,
			),
		).toContain("does not support it");

		expect(_test.applyFastServiceTier({ model: "gpt-5.4" })).toEqual({
			model: "gpt-5.4",
			service_tier: "priority",
		});
		expect(_test.applyFastServiceTier("not-an-object")).toBe("not-an-object");
	});
});
