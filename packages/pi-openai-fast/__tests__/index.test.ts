import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piOpenAIFast, { _test } from "../extensions/index.js";

type RegisteredFlag = {
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
};

type RegisteredHandlers = Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;

type MockPi = {
	commands: Map<string, Omit<RegisteredCommand, "name">>;
	flags: Map<string, RegisteredFlag>;
	handlers: RegisteredHandlers;
	appendEntry: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
};

type MockUi = {
	notify: ReturnType<typeof vi.fn>;
	theme: {
		fg: (color: string, text: string) => string;
	};
};

function createMockPi(flagValue?: boolean): MockPi {
	const commands = new Map<string, Omit<RegisteredCommand, "name">>();
	const flags = new Map<string, RegisteredFlag>();
	const handlers: RegisteredHandlers = new Map();

	return {
		commands,
		flags,
		handlers,
		appendEntry: vi.fn(),
		getFlag: vi.fn((name: string) => (name === _test.FAST_FLAG ? flagValue : undefined)),
		registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name">) => {
			commands.set(name, options);
		}),
		registerFlag: vi.fn((name: string, options: RegisteredFlag) => {
			flags.set(name, options);
		}),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		}),
	};
}

function createMockContext(
	model: ExtensionContext["model"],
	branch: unknown[] = [],
): { ctx: ExtensionCommandContext; ui: MockUi } {
	const ui: MockUi = {
		notify: vi.fn(),
		theme: {
			fg: (color, text) => `${color}:${text}`,
		},
	};

	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: {
			getBranch: () => branch,
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

describe("pi-openai-fast", () => {
	it("registers the fast command and flag", () => {
		const mockPi = createMockPi();
		piOpenAIFast(mockPi as unknown as ExtensionAPI);

		expect(mockPi.commands.has("fast")).toBe(true);
		expect(mockPi.flags.get("fast")).toEqual({
			description: "Start with OpenAI fast mode enabled",
			type: "boolean",
			default: false,
		});
		expect(mockPi.handlers.has("before_provider_request")).toBe(true);
		expect(mockPi.handlers.has("session_start")).toBe(true);
	});

	it("enables fast mode for supported models and injects the priority service tier", async () => {
		const mockPi = createMockPi();
		piOpenAIFast(mockPi as unknown as ExtensionAPI);

		const command = getRegisteredCommand(mockPi, "fast");
		const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");

		const { ctx, ui } = createMockContext({ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"]);
		await command.handler("on", ctx);

		expect(mockPi.appendEntry).toHaveBeenCalledWith(_test.FAST_STATE_ENTRY, { active: true });
		expect(ui.notify).toHaveBeenCalledWith("Fast mode is on for openai/gpt-5.4.", "info");

		const payload = beforeProviderRequest(
			{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
			ctx,
		);
		expect(payload).toEqual({ input: "hello", service_tier: "priority" });
	});

	it("keeps fast mode active but skips payload changes on unsupported models", async () => {
		const mockPi = createMockPi();
		piOpenAIFast(mockPi as unknown as ExtensionAPI);

		const command = getRegisteredCommand(mockPi, "fast");
		const beforeProviderRequest = getRegisteredHandler(mockPi, "before_provider_request");

		const { ctx, ui } = createMockContext({
			provider: "anthropic",
			id: "claude-sonnet-4",
		} as ExtensionContext["model"]);
		await command.handler("on", ctx);

		expect(ui.notify).toHaveBeenCalledWith(
			"Fast mode is on, but anthropic/claude-sonnet-4 does not support it. Supported models: openai/gpt-5.4, openai-codex/gpt-5.4.",
			"info",
		);

		const payload = beforeProviderRequest(
			{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
			ctx,
		);
		expect(payload).toBeUndefined();
	});

	it("restores saved state on session start and honors the --fast flag", async () => {
		const savedState = [
			{
				type: "custom",
				customType: _test.FAST_STATE_ENTRY,
				data: { active: true },
			},
		];

		const restoredPi = createMockPi();
		piOpenAIFast(restoredPi as unknown as ExtensionAPI);

		const restoredSessionStart = getRegisteredHandler(restoredPi, "session_start");
		const restoredBeforeProviderRequest = getRegisteredHandler(restoredPi, "before_provider_request");

		const restoredContext = createMockContext(
			{ provider: "openai-codex", id: "gpt-5.4" } as ExtensionContext["model"],
			savedState,
		);
		await restoredSessionStart({ type: "session_start" }, restoredContext.ctx);
		expect(
			restoredBeforeProviderRequest(
				{ type: "before_provider_request", payload: { input: "hello" } } as BeforeProviderRequestEvent,
				restoredContext.ctx,
			),
		).toEqual({ input: "hello", service_tier: "priority" });

		const flaggedPi = createMockPi(true);
		piOpenAIFast(flaggedPi as unknown as ExtensionAPI);

		const flaggedSessionStart = getRegisteredHandler(flaggedPi, "session_start");

		const flaggedContext = createMockContext({ provider: "openai", id: "gpt-5.4" } as ExtensionContext["model"]);
		await flaggedSessionStart({ type: "session_start" }, flaggedContext.ctx);
		expect(flaggedPi.appendEntry).toHaveBeenCalledWith(_test.FAST_STATE_ENTRY, { active: true });
		expect(flaggedContext.ui.notify).toHaveBeenCalledWith("Fast mode is on for openai/gpt-5.4.", "info");
	});
});
