import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "@mariozechner/pi-coding-agent";
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

function createTempWorkspace(): { cwd: string; homeDir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pi-openai-verbosity-"));
	const cwd = join(root, "workspace");
	const homeDir = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	return {
		cwd,
		homeDir,
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
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);

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
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
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
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
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

	it("injects low text verbosity for every default configured model", () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);

			const mockPi = createMockPi();
			piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);
			const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");

			for (const modelKey of Object.keys(_test.DEFAULT_MODEL_VERBOSITY)) {
				const id = modelKey.slice("openai-codex/".length);
				const { ctx } = createMockContext({ provider: "openai-codex", id } as ExtensionContext["model"], cwd);
				expect(
					beforeProviderRequest(
						{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
						ctx,
					),
				).toEqual({ input: "hello", text: { verbosity: "low" } });
			}
		} finally {
			cleanup();
		}
	});

	it("skips payload changes for unconfigured models", () => {
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);

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
		const { cwd, homeDir, cleanup } = createTempWorkspace();
		try {
			vi.stubEnv("HOME", homeDir);
			const { globalConfigPath } = _test.getConfigPaths(cwd, homeDir);
			mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
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

	it("reports usage for invalid command arguments", async () => {
		const mockPi = createMockPi();
		piOpenAIVerbosity(mockPi as unknown as ExtensionAPI);

		const command = getRegisteredCommand(mockPi, "openai-verbosity");
		const { ctx, ui } = createMockContext({ provider: "openai-codex", id: "gpt-5.5" } as ExtensionContext["model"]);
		await command.handler("loud", ctx);

		expect(ui.notify).toHaveBeenCalledWith("Usage: /openai-verbosity [status]", "error");
	});
});
