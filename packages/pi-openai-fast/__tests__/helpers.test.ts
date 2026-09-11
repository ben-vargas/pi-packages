import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { _test } from "../extensions/index.js";

function createContext(model: ExtensionContext["model"]): ExtensionContext {
	return {
		model,
	} as unknown as ExtensionContext;
}

function createTempConfigPaths(): { cwd: string; homeDir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pi-openai-fast-"));
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

describe("pi-openai-fast helpers", () => {
	it("parses supported model keys and recognizes supported fast models", () => {
		const supportedModels = _test.parseSupportedModels(_test.DEFAULT_SUPPORTED_MODEL_KEYS) ?? [];
		expect(_test.parseSupportedModelKey("openai/gpt-5.4")).toEqual({ provider: "openai", id: "gpt-5.4" });
		expect(_test.parseSupportedModelKey("openai/gpt-5.5")).toEqual({ provider: "openai", id: "gpt-5.5" });
		expect(_test.parseSupportedModelKey("openai/gpt-5.6-sol")).toEqual({
			provider: "openai",
			id: "gpt-5.6-sol",
		});
		expect(_test.parseSupportedModelKey("invalid-model")).toBeUndefined();
		expect(
			_test.isFastSupportedModel({ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"], supportedModels),
		).toBe(true);
		expect(
			_test.isFastSupportedModel({ provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"], supportedModels),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-5.4" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai", id: "gpt-5.6-luna" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai", id: "gpt-5.4-mini" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-5.4-mini" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(false);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-5.6-terra" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai", id: "gpt-6-astra" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "openai-codex", id: "gpt-6-astra" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(true);
		expect(
			_test.isFastSupportedModel(
				{ provider: "anthropic", id: "claude-sonnet-4" } as ExtensionContext["model"],
				supportedModels,
			),
		).toBe(false);
		expect(_test.isFastSupportedModel(undefined, supportedModels)).toBe(false);
		expect(_test.describeSupportedModels([])).toBe("none configured");
	});

	it("writes a default config and resolves project overrides", () => {
		const { cwd, homeDir, cleanup } = createTempConfigPaths();
		try {
			const defaultConfig = _test.resolveFastConfig(cwd, homeDir);
			expect(defaultConfig.persistState).toBe(true);
			expect(defaultConfig.active).toBe(false);
			expect(defaultConfig.supportedModels).toEqual([
				{ provider: "openai", id: "gpt-5.4" },
				{ provider: "openai", id: "gpt-5.4-mini" },
				{ provider: "openai", id: "gpt-5.5" },
				{ provider: "openai", id: "gpt-5.6-sol" },
				{ provider: "openai", id: "gpt-5.6-terra" },
				{ provider: "openai", id: "gpt-5.6-luna" },
				{ provider: "openai", id: "gpt-6-astra" },
				{ provider: "openai-codex", id: "gpt-5.4" },
				{ provider: "openai-codex", id: "gpt-5.5" },
				{ provider: "openai-codex", id: "gpt-5.6-sol" },
				{ provider: "openai-codex", id: "gpt-5.6-terra" },
				{ provider: "openai-codex", id: "gpt-5.6-luna" },
				{ provider: "openai-codex", id: "gpt-6-astra" },
			]);

			const { projectConfigPath, globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			expect(_test.readConfigFile(globalConfigPath)).toEqual(_test.DEFAULT_CONFIG_FILE);

			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				projectConfigPath,
				`${JSON.stringify({ persistState: false, supportedModels: ["openai/gpt-5.5"] }, null, 2)}\n`,
				"utf-8",
			);

			const overriddenConfig = _test.resolveFastConfig(cwd, homeDir);
			expect(overriddenConfig.configPath).toBe(projectConfigPath);
			expect(overriddenConfig.persistState).toBe(false);
			expect(overriddenConfig.active).toBe(false);
			expect(overriddenConfig.supportedModels).toEqual([{ provider: "openai", id: "gpt-5.5" }]);
			expect(_test.readConfigFile(projectConfigPath)).toEqual({
				persistState: false,
				supportedModels: ["openai/gpt-5.5"],
			});
		} finally {
			cleanup();
		}
	});

	it("resolves the global config from PI_CODING_AGENT_DIR when no homeDir override is given", () => {
		const { cwd, homeDir, cleanup } = createTempConfigPaths();
		try {
			const agentDir = join(homeDir, "relocated-agent");
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

			const { globalConfigPath } = _test.getConfigPaths(cwd);
			expect(globalConfigPath).toBe(join(agentDir, "extensions", _test.FAST_CONFIG_BASENAME));

			const config = _test.resolveFastConfig(cwd);
			expect(config.configPath).toBe(globalConfigPath);
			expect(existsSync(globalConfigPath)).toBe(true);

			const explicitPaths = _test.getConfigPaths(cwd, homeDir);
			expect(explicitPaths.globalConfigPath).toBe(
				join(homeDir, ".pi", "agent", "extensions", _test.FAST_CONFIG_BASENAME),
			);
		} finally {
			vi.unstubAllEnvs();
			cleanup();
		}
	});

	it("migrates legacy default supported models without changing custom supported models", () => {
		for (const legacyKeys of _test.LEGACY_DEFAULT_SUPPORTED_MODEL_KEY_SETS) {
			expect(_test.migrateSupportedModelKeys([...legacyKeys])).toEqual([..._test.DEFAULT_SUPPORTED_MODEL_KEYS]);
		}
		// The 1.1.0 default (eleven models, gpt-5.4-mini included) is a legacy set now.
		expect(
			_test.migrateSupportedModelKeys([
				"openai/gpt-5.4",
				"openai/gpt-5.4-mini",
				"openai/gpt-5.5",
				"openai/gpt-5.6-sol",
				"openai/gpt-5.6-terra",
				"openai/gpt-5.6-luna",
				"openai-codex/gpt-5.4",
				"openai-codex/gpt-5.5",
				"openai-codex/gpt-5.6-sol",
				"openai-codex/gpt-5.6-terra",
				"openai-codex/gpt-5.6-luna",
			]),
		).toContain("openai-codex/gpt-6-astra");
		expect(_test.migrateSupportedModelKeys(["openai/gpt-5.4"])).toEqual(["openai/gpt-5.4"]);
		expect(_test.migrateSupportedModelKeys(undefined)).toBeUndefined();
	});

	it("describes the current state and injects the priority service tier", () => {
		const supportedModels = _test.parseSupportedModels(_test.DEFAULT_SUPPORTED_MODEL_KEYS) ?? [];
		expect(_test.describeCurrentState(createContext(undefined), false, supportedModels)).toBe(
			"Fast mode is off. Current model: none.",
		);
		expect(
			_test.describeCurrentState(
				createContext({ provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"]),
				true,
				supportedModels,
			),
		).toBe("Fast mode is on for openai/gpt-5.5.");
		expect(
			_test.describeCurrentState(
				createContext({ provider: "anthropic", id: "claude-sonnet-4" } as ExtensionContext["model"]),
				true,
				supportedModels,
			),
		).toContain("does not support it");

		expect(_test.applyFastServiceTier({ model: "gpt-5.4" })).toEqual({
			model: "gpt-5.4",
			service_tier: "priority",
		});
		expect(_test.applyFastServiceTier("not-an-object")).toBe("not-an-object");
	});
});
