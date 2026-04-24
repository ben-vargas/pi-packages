import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { _test } from "../extensions/index.js";

function createContext(model: ExtensionContext["model"]): ExtensionContext {
	return {
		model,
	} as unknown as ExtensionContext;
}

function createTempConfigPaths(): { cwd: string; homeDir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pi-openai-verbosity-"));
	const cwd = join(root, "workspace");
	const homeDir = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	return {
		cwd,
		homeDir,
		cleanup: () => {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("pi-openai-verbosity helpers", () => {
	it("normalizes model keys and verbosity maps", () => {
		expect(_test.normalizeModelKey(" openai-codex/gpt-5.5 ")).toBe("openai-codex/gpt-5.5");
		expect(_test.normalizeModelKey("gpt-5.5")).toBeUndefined();
		expect(_test.normalizeModelKey("openai/gpt-5.5")).toBeUndefined();
		expect(
			_test.normalizeModelVerbosityMap({ " openai-codex/gpt-5.5 ": "low", "openai-codex/gpt-5.4": "loud" }),
		).toEqual({
			"openai-codex/gpt-5.5": "low",
		});
		expect(_test.normalizeModelVerbosityMap([])).toBeUndefined();
	});

	it("writes a default config and resolves project overrides", () => {
		const { cwd, homeDir, cleanup } = createTempConfigPaths();
		try {
			const defaultConfig = _test.resolveVerbosityConfig(cwd, homeDir);
			expect(defaultConfig.models).toEqual(_test.DEFAULT_MODEL_VERBOSITY);
			expect(defaultConfig.models).toMatchObject({
				"openai-codex/gpt-5.4": "low",
				"openai-codex/gpt-5.5": "low",
				"openai-codex/gpt-5.4-mini": "low",
				"openai-codex/gpt-5.3-codex": "low",
				"openai-codex/gpt-5.3-codex-spark": "low",
				"openai-codex/gpt-5.2": "low",
				"openai-codex/codex-auto-review": "low",
			});

			const { projectConfigPath, globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			expect(_test.readConfigFile(globalConfigPath)).toEqual(_test.DEFAULT_CONFIG_FILE);

			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				projectConfigPath,
				`${JSON.stringify({ models: { "openai-codex/gpt-5.5": "medium", "openai-codex/gpt-5.4": "low" } }, null, 2)}\n`,
				"utf-8",
			);

			const overriddenConfig = _test.resolveVerbosityConfig(cwd, homeDir);
			expect(overriddenConfig.configPath).toBe(projectConfigPath);
			expect(overriddenConfig.models).toMatchObject({
				"openai-codex/gpt-5.5": "medium",
				"openai-codex/gpt-5.4": "low",
			});
		} finally {
			cleanup();
		}
	});

	it("describes state and applies text verbosity without dropping text fields", () => {
		const config = {
			configPath: "/tmp/pi-openai-verbosity.json",
			models: { "openai-codex/gpt-5.5": "low" as const },
		};
		expect(
			_test.describeCurrentState(
				createContext({ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"]),
				config,
			),
		).toBe("OpenAI verbosity sets text.verbosity=low for openai-codex/gpt-5.5.");
		expect(_test.describeCurrentState(createContext(undefined), config)).toContain("none");
		expect(
			_test.applyTextVerbosity({ input: "hello", text: { format: { type: "text" }, verbosity: "medium" } }, "low"),
		).toEqual({
			input: "hello",
			text: {
				format: { type: "text" },
				verbosity: "low",
			},
		});
		expect(_test.applyTextVerbosity("not-an-object", "low")).toBe("not-an-object");
	});

	it("writes JSONL debug entries with timestamps", () => {
		const { cwd, cleanup } = createTempConfigPaths();
		try {
			const debugLogPath = join(cwd, "debug", "verbosity.jsonl");
			_test.writeDebugLog({ model: "openai-codex/gpt-5.5", matched: true }, debugLogPath);

			const line = readFileSync(debugLogPath, "utf-8").trim();
			const entry = JSON.parse(line) as Record<string, unknown>;
			expect(entry.timestamp).toEqual(expect.any(String));
			expect(entry.model).toBe("openai-codex/gpt-5.5");
			expect(entry.matched).toBe(true);
		} finally {
			cleanup();
		}
	});
});
