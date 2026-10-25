import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piOpenAIVerbosity, { _test } from "../extensions/index.js";

type RegisteredHandlers = Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;

type MockPi = {
	commands: Map<string, Omit<RegisteredCommand, "name">>;
	handlers: RegisteredHandlers;
	registerCommand: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
};

type MockUi = {
	notify: ReturnType<typeof vi.fn>;
};

function createTempWorkspace(): { cwd: string; homeDir: string; agentDir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pi-openai-verbosity-"));
	const cwd = join(root, "workspace");
	const homeDir = join(root, "home");
	const agentDir = join(homeDir, ".pi", "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	return {
		cwd,
		homeDir,
		agentDir,
		cleanup: () => {
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function createMockPi(): MockPi {
	const commands = new Map<string, Omit<RegisteredCommand, "name">>();
	const handlers: RegisteredHandlers = new Map();

	return {
		commands,
		handlers,
		registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name">) => {
			commands.set(name, options);
		}),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		}),
	};
}

function createMockContext(
	model: ExtensionContext["model"],
	cwd: string = process.cwd(),
): { ctx: ExtensionCommandContext; ui: MockUi } {
	const ui: MockUi = {
		notify: vi.fn(),
	};

	const ctx = {
		hasUI: true,
		cwd,
		sessionManager: {
			getBranch: () => [],
		},
		modelRegistry: {},
		model,
		ui,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => undefined,
	} as unknown as ExtensionCommandContext;

	return { ctx, ui };
}

function getRegisteredCommand(mockPi: MockPi, name: string): Omit<RegisteredCommand, "name"> {
	const command = mockPi.commands.get(name);
	expect(command).toBeDefined();
	if (!command) {
		throw new Error(`Missing command: ${name}`);
	}
	return command;
}

function getRegisteredHandler(mockPi: MockPi, eventName: string): (event: unknown, ctx: ExtensionContext) => unknown {
	const handler = mockPi.handlers.get(eventName);
	expect(handler).toBeDefined();
	if (!handler) {
		throw new Error(`Missing handler: ${eventName}`);
	}
	return handler;
}

describe("pi-openai-verbosity", () => {
	it("registers the openai-verbosity command and provider request hook", () => {
		const mockPi = createMockPi();
		piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);

		expect(mockPi.commands.has("openai-verbosity")).toBe(true);
		expect(mockPi.handlers.has("before_provider_request")).toBe(true);
	});

	it("injects low text verbosity for the default configured model", () => {
		const { cwd, homeDir, agentDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx } = createMockContext({ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"], cwd);

			const payload = beforeProviderRequest(
				{
					type: "before_provider_request",
					payload: { input: "hello", text: { verbosity: "medium" } },
				} as BeforeProviderRequestEvent,
				ctx,
			);
			expect(payload).toEqual({ input: "hello", text: { verbosity: "low" } });
		} finally {
			cleanup();
		}
	});

	it("writes before and after debug entries when verbosity is applied", () => {
		const { cwd, homeDir, agentDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			const debugLogPath = join(cwd, "debug", "verbosity.jsonl");
			vi.stubEnv("PI_OPENAI_VERBOSITY_DEBUG_LOG", debugLogPath);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx } = createMockContext({ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"], cwd);

			beforeProviderRequest(
				{
					type: "before_provider_request",
					payload: { input: "hello", text: { verbosity: "medium" } },
				} as BeforeProviderRequestEvent,
				ctx,
			);

			const entries = readFileSync(debugLogPath, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(entries).toHaveLength(2);
			expect(entries[0]).toMatchObject({
				stage: "before",
				model: "openai-codex/gpt-5.5",
				matched: true,
				configuredVerbosity: "low",
				beforeTextVerbosity: "medium",
				payload: { input: "hello", text: { verbosity: "medium" } },
			});
			expect(entries[1]).toMatchObject({
				stage: "after",
				model: "openai-codex/gpt-5.5",
				matched: true,
				configuredVerbosity: "low",
				beforeTextVerbosity: "medium",
				afterTextVerbosity: "low",
				payload: { input: "hello", text: { verbosity: "low" } },
			});
			expect(entries[0]?.timestamp).toEqual(expect.any(String));
			expect(entries[1]?.timestamp).toEqual(expect.any(String));
		} finally {
			cleanup();
		}
	});

	it("writes a debug entry when a model is not configured", () => {
		const { cwd, homeDir, agentDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			const debugLogPath = join(cwd, "debug", "verbosity.jsonl");
			vi.stubEnv("PI_OPENAI_VERBOSITY_DEBUG_LOG", debugLogPath);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx } = createMockContext({ provider: "openai-codex", id: "gpt-5.1" } as ExtensionContext["model"], cwd);

			beforeProviderRequest(
				{
					type: "before_provider_request",
					payload: { input: "hello", text: { verbosity: "medium" } },
				} as BeforeProviderRequestEvent,
				ctx,
			);

			const entry = JSON.parse(readFileSync(debugLogPath, "utf-8").trim()) as Record<string, unknown>;
			expect(entry).toMatchObject({
				stage: "skipped",
				model: "openai-codex/gpt-5.1",
				matched: false,
				beforeTextVerbosity: "medium",
				payload: { input: "hello", text: { verbosity: "medium" } },
			});
			expect(entry.timestamp).toEqual(expect.any(String));
		} finally {
			cleanup();
		}
	});

	it("injects the default text verbosity for every default configured model", () => {
		const { cwd, homeDir, agentDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");

			for (const [modelKey, verbosity] of Object.entries(_test.DEFAULT_MODEL_VERBOSITY)) {
				const slashIndex = modelKey.indexOf("/");
				const provider = modelKey.slice(0, slashIndex);
				const id = modelKey.slice(slashIndex + 1);
				const { ctx } = createMockContext({ provider, id } as ExtensionContext["model"], cwd);
				expect(
					beforeProviderRequest(
						{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
						ctx,
					),
				).toEqual({ input: "hello", text: { verbosity } });
			}
		} finally {
			cleanup();
		}
	});

	it("skips payload changes for unconfigured models", () => {
		const { cwd, homeDir, agentDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx } = createMockContext({ provider: "openai-codex", id: "gpt-5.1" } as ExtensionContext["model"], cwd);

			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("uses configured verbosity per model and refreshes config on /openai-verbosity status", async () => {
		const { cwd, homeDir, agentDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir, agentDir);
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(
				globalConfigPath,
				`${JSON.stringify({ models: { "openai-codex/gpt-5.5": "high" } }, null, 2)}\n`,
				"utf-8",
			);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const command = getRegisteredCommand(mockPi, "openai-verbosity");
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx, ui } = createMockContext(
				{ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"],
				cwd,
			);

			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", text: { verbosity: "high" } });

			writeFileSync(
				globalConfigPath,
				`${JSON.stringify({ models: { "openai-codex/gpt-5.5": "low" } }, null, 2)}\n`,
				"utf-8",
			);
			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", text: { verbosity: "high" } });

			await command.handler("status", ctx);
			expect(ui.notify).toHaveBeenLastCalledWith(
				"OpenAI verbosity sets text.verbosity=low for openai-codex/gpt-5.5.",
				"info",
			);
			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", text: { verbosity: "low" } });
		} finally {
			cleanup();
		}
	});

	it("seeds the default global config under PI_CODING_AGENT_DIR when it is set", () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			const relocatedAgentDir = join(homeDir, "relocated-agent");
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", relocatedAgentDir);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx } = createMockContext(
				{ provider: "openai-codex", id: "gpt-5.6-sol" } as ExtensionContext["model"],
				cwd,
			);

			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", text: { verbosity: "low" } });

			const seededConfigPath = join(relocatedAgentDir, "extensions", "pi-openai-verbosity.json");
			expect(existsSync(seededConfigPath)).toBe(true);
			expect(JSON.parse(readFileSync(seededConfigPath, "utf-8"))).toEqual(_test.DEFAULT_CONFIG_FILE);
			expect(existsSync(join(homeDir, ".pi", "agent", "extensions", "pi-openai-verbosity.json"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("falls back to a legacy ~/.pi/agent config when PI_CODING_AGENT_DIR is relocated", () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			const relocatedAgentDir = join(homeDir, "relocated-agent");
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", relocatedAgentDir);

			const legacyConfigPath = join(homeDir, ".pi", "agent", "extensions", "pi-openai-verbosity.json");
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			const legacyRaw = `${JSON.stringify({ models: { "openai-codex/gpt-5.5": "high" } }, null, 2)}\n`;
			writeFileSync(legacyConfigPath, legacyRaw, "utf-8");

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx } = createMockContext({ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"], cwd);

			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", text: { verbosity: "high" } });

			const resolved = _test.resolveVerbosityConfig(cwd);
			expect(resolved.configPath).toBe(legacyConfigPath);
			expect(resolved.models["openai-codex/gpt-5.5"]).toBe("high");

			// The legacy file is read in place: no default is seeded into the relocated
			// directory and the legacy file itself is never rewritten.
			expect(existsSync(join(relocatedAgentDir, "extensions", "pi-openai-verbosity.json"))).toBe(false);
			expect(readFileSync(legacyConfigPath, "utf-8")).toBe(legacyRaw);
		} finally {
			cleanup();
		}
	});

	it("prefers a relocated global config over the legacy ~/.pi/agent config", () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			const relocatedAgentDir = join(homeDir, "relocated-agent");
			vi.stubEnv("HOME", homeDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", relocatedAgentDir);

			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
			writeFileSync(
				join(homeDir, ".pi", "agent", "extensions", "pi-openai-verbosity.json"),
				`${JSON.stringify({ models: { "openai-codex/gpt-5.5": "high" } }, null, 2)}\n`,
				"utf-8",
			);
			mkdirSync(join(relocatedAgentDir, "extensions"), { recursive: true });
			writeFileSync(
				join(relocatedAgentDir, "extensions", "pi-openai-verbosity.json"),
				`${JSON.stringify({ models: { "openai-codex/gpt-5.5": "medium" } }, null, 2)}\n`,
				"utf-8",
			);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");
			const { ctx } = createMockContext({ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"], cwd);

			expect(
				beforeProviderRequest(
					{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
					ctx,
				),
			).toEqual({ input: "hello", text: { verbosity: "medium" } });
		} finally {
			cleanup();
		}
	});

	it("keeps legacy homeDir injection working in the exported helpers", () => {
		const { cwd, homeDir, agentDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("PI_CODING_AGENT_DIR", "");

			const paths = _test.getConfigPaths(cwd, homeDir);
			const expectedGlobalPath = join(agentDir, "extensions", "pi-openai-verbosity.json");
			expect(paths.globalConfigPath).toBe(expectedGlobalPath);
			expect(paths.legacyGlobalConfigPath).toBe(expectedGlobalPath);

			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(
				expectedGlobalPath,
				`${JSON.stringify({ models: { "openai-codex/gpt-5.5": "high" } }, null, 2)}\n`,
				"utf-8",
			);

			const resolved = _test.resolveVerbosityConfig(cwd, homeDir);
			expect(resolved.configPath).toBe(expectedGlobalPath);
			expect(resolved.models["openai-codex/gpt-5.5"]).toBe("high");
		} finally {
			cleanup();
		}
	});

	it("reports usage for invalid command arguments", async () => {
		const mockPi = createMockPi();
		piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);

		const command = getRegisteredCommand(mockPi, "openai-verbosity");
		const { ctx, ui } = createMockContext({ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"]);
		await command.handler("loud", ctx);

		expect(ui.notify).toHaveBeenCalledWith("Usage: /openai-verbosity [status]", "error");
	});
});
