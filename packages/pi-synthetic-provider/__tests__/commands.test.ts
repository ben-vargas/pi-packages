import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSyntheticModelsCommand } from "../extensions/commands/synthetic-models.js";
import { registerSyntheticQuotaCommand } from "../extensions/commands/synthetic-quota.js";

// ---------------------------------------------------------------------------
// Module-level mock for @mariozechner/pi-tui
// Captures SelectList instances so tests can trigger onSelect / onCancel.
// ---------------------------------------------------------------------------

interface MockSelectList {
	onSelectionChange?: (item: { value: string }) => void;
	onSelect?: (item: { value: string }) => void;
	onCancel?: () => void;
	handleInput: ReturnType<typeof vi.fn>;
	render: ReturnType<typeof vi.fn>;
	invalidate: ReturnType<typeof vi.fn>;
}

let lastSelectList: MockSelectList | null = null;

vi.mock("@mariozechner/pi-tui", async (importOriginal) => {
	const original = await importOriginal<typeof import("@mariozechner/pi-tui")>();

	class MockBox {
		addChild = vi.fn();
		render = vi.fn().mockReturnValue([]);
		invalidate = vi.fn();
	}
	class MockContainer {
		addChild = vi.fn();
	}
	class MockSpacer {
		render = vi.fn().mockReturnValue([]);
		invalidate = vi.fn();
	}
	class MockText {
		setText = vi.fn();
	}
	class MockSelectListImpl {
		onSelectionChange?: (item: { value: string }) => void;
		onSelect?: (item: { value: string }) => void;
		onCancel?: () => void;
		handleInput = vi.fn();
		render = vi.fn().mockReturnValue([]);
		invalidate = vi.fn();
		constructor() {
			lastSelectList = this;
		}
	}
	return {
		...original,
		Box: MockBox,
		Container: MockContainer,
		Spacer: MockSpacer,
		Text: MockText,
		SelectList: MockSelectListImpl,
	};
});

// Also mock DynamicBorder from @mariozechner/pi-coding-agent
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
	const original = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
	class MockDynamicBorder {
		render = vi.fn().mockReturnValue([]);
		invalidate = vi.fn();
	}
	return {
		...original,
		DynamicBorder: MockDynamicBorder,
	};
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shape returned by the TUI renderer factory callback. */
interface RendererResult {
	render: (width: number) => unknown;
	invalidate: () => void;
	handleInput: (data: string) => void;
}

const createMockPi = () =>
	({
		registerCommand: vi.fn(),
		setModel: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

type MockPi = ReturnType<typeof createMockPi>;

/** Extract the handler function that was passed to `pi.registerCommand(name, { handler })`. */
function getHandler(mockPi: MockPi, commandName: string) {
	const call = mockPi.registerCommand.mock.calls.find(([name]) => name === commandName);
	if (!call) throw new Error(`Command "${commandName}" was not registered`);
	return call[1].handler as (args: string, ctx: ReturnType<typeof createMockCtx>) => Promise<void>;
}

/** Create a mock theme object that returns text unchanged for any formatting call. */
const createMockTheme = () => ({
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
});

/** Create a mock TUI object for the renderer callback. */
const createMockTui = () => ({
	terminal: { rows: 50, columns: 140 },
	requestRender: vi.fn(),
});

/**
 * Create a `ctx.ui.custom` mock that captures the renderer factory callback,
 * invokes it with mock TUI/theme, and returns the renderer result for assertions.
 */
function createCapturingCustomMock() {
	let capturedRenderer: RendererResult | null = null;
	const doneFn = vi.fn();

	// biome-ignore lint/suspicious/noExplicitAny: test helper needs to accept the opaque factory shape
	const customFn = vi.fn().mockImplementation(async (factory: (...args: any[]) => RendererResult) => {
		capturedRenderer = factory(createMockTui(), createMockTheme(), {}, doneFn);
	});

	return {
		customFn,
		getCapturedRenderer: (): RendererResult => {
			if (!capturedRenderer) throw new Error("Renderer was not captured — was ctx.ui.custom called?");
			return capturedRenderer;
		},
		doneFn,
	};
}

const createMockCtx = (
	overrides: { hasUI?: boolean; isIdle?: boolean; apiKey?: string | undefined } = {},
	customMock?: ReturnType<typeof vi.fn>,
) => ({
	hasUI: overrides.hasUI ?? true,
	isIdle: vi.fn().mockReturnValue(overrides.isIdle ?? true),
	ui: {
		notify: vi.fn(),
		custom: customMock ?? vi.fn().mockResolvedValue(undefined),
	},
	modelRegistry: {
		getApiKeyForProvider: vi.fn().mockResolvedValue(overrides.apiKey ?? "syn_test_key"),
		find: vi.fn(),
		registerProvider: vi.fn(),
	},
});

/** Standard mock API response with one always-on model. */
const SINGLE_MODEL_RESPONSE = {
	ok: true,
	json: vi.fn().mockResolvedValue({
		data: [
			{
				id: "hf:test/model",
				hugging_face_id: "test/model",
				name: "Test Model",
				input_modalities: ["text"],
				output_modalities: ["text"],
				context_length: 128000,
				max_output_length: 32768,
				pricing: { prompt: "$0.001", completion: "$0.002" },
				supported_features: ["tools", "reasoning"],
				always_on: true,
				provider: "synthetic",
			},
		],
	}),
};

// ---------------------------------------------------------------------------
// /synthetic-models command tests
// ---------------------------------------------------------------------------

describe("/synthetic-models command", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		lastSelectList = null;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("exits early when ctx.hasUI is false", async () => {
		const mockPi = createMockPi();
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		const ctx = createMockCtx({ hasUI: false });
		await handler("", ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("warns and exits when not idle", async () => {
		const mockPi = createMockPi();
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		const ctx = createMockCtx({ isIdle: false });
		await handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("current response"), "warning");
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("opens overlay and renderer supports input handling", async () => {
		const mockPi = createMockPi();
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		vi.mocked(fetch).mockResolvedValue(SINGLE_MODEL_RESPONSE as unknown as Response);

		const { customFn, getCapturedRenderer } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		await handler("", ctx);

		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		expect(ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));

		const renderer = getCapturedRenderer();
		expect(typeof renderer.render).toBe("function");
		expect(typeof renderer.invalidate).toBe("function");
		expect(typeof renderer.handleInput).toBe("function");

		// Exercise handleInput — should not throw
		renderer.handleInput("j");
		renderer.handleInput("k");
		renderer.render(120);
	});

	it("cancel via onCancel calls done to close overlay", async () => {
		const mockPi = createMockPi();
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		vi.mocked(fetch).mockResolvedValue(SINGLE_MODEL_RESPONSE as unknown as Response);

		const { customFn, doneFn } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		await handler("", ctx);

		expect(lastSelectList).toBeTruthy();
		expect(lastSelectList?.onCancel).toBeDefined();

		lastSelectList?.onCancel?.();
		expect(doneFn).toHaveBeenCalledTimes(1);
	});

	it("onSelect switches model when registered", async () => {
		const mockPi = createMockPi();
		mockPi.setModel.mockResolvedValue(true);
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		vi.mocked(fetch).mockResolvedValue(SINGLE_MODEL_RESPONSE as unknown as Response);

		const { customFn, doneFn } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		ctx.modelRegistry.find.mockReturnValue({ id: "hf:test/model", provider: "synthetic" });
		await handler("", ctx);

		expect(lastSelectList?.onSelect).toBeDefined();

		// Trigger model selection
		lastSelectList?.onSelect?.({ value: "synthetic:hf:test/model" });

		// onSelect uses void async, flush microtasks
		await vi.waitFor(() => {
			expect(mockPi.setModel).toHaveBeenCalled();
		});

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Switched model"), "info");
		expect(doneFn).toHaveBeenCalled();
	});

	it("onSelect shows error when setModel returns false", async () => {
		const mockPi = createMockPi();
		mockPi.setModel.mockResolvedValue(false);
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		vi.mocked(fetch).mockResolvedValue(SINGLE_MODEL_RESPONSE as unknown as Response);

		const { customFn, doneFn } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		ctx.modelRegistry.find.mockReturnValue({ id: "hf:test/model", provider: "synthetic" });
		await handler("", ctx);

		lastSelectList?.onSelect?.({ value: "synthetic:hf:test/model" });

		await vi.waitFor(() => {
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No API key"), "error");
		});

		expect(doneFn).not.toHaveBeenCalled();
	});

	it("onSelect warns when model is not in registry", async () => {
		const mockPi = createMockPi();
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		vi.mocked(fetch).mockResolvedValue(SINGLE_MODEL_RESPONSE as unknown as Response);

		const { customFn } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		ctx.modelRegistry.find.mockReturnValue(undefined);
		await handler("", ctx);

		lastSelectList?.onSelect?.({ value: "synthetic:hf:test/model" });

		await vi.waitFor(() => {
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not currently registered"), "warning");
		});

		expect(mockPi.setModel).not.toHaveBeenCalled();
	});

	it("warns when no always-on models are returned", async () => {
		const mockPi = createMockPi();
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		const mockResponse = {
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [{ id: "off-model", always_on: false }] }),
		};
		vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

		const ctx = createMockCtx();
		await handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No always-on"), "warning");
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("shows error notification when fetch fails", async () => {
		const mockPi = createMockPi();
		registerSyntheticModelsCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-models");

		vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

		const ctx = createMockCtx();
		await handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Network error"), "error");
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// /synthetic-quota command tests
// ---------------------------------------------------------------------------

describe("/synthetic-quota command", () => {
	let savedApiKey: string | undefined;

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		savedApiKey = process.env.SYNTHETIC_API_KEY;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		if (savedApiKey !== undefined) {
			process.env.SYNTHETIC_API_KEY = savedApiKey;
		} else {
			delete process.env.SYNTHETIC_API_KEY;
		}
	});

	it("exits early when ctx.hasUI is false", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		const ctx = createMockCtx({ hasUI: false });
		await handler("", ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("warns and exits when not idle", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		const ctx = createMockCtx({ isIdle: false });
		await handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("current response"), "warning");
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("shows error when API key is missing", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		const ctx = createMockCtx({ apiKey: undefined });
		delete process.env.SYNTHETIC_API_KEY;
		ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue(undefined);
		await handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not configured"), "error");
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("opens overlay and renderer handles Esc to close", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		const mockResponse = {
			ok: true,
			json: vi.fn().mockResolvedValue({
				subscription: { limit: 135, requests: 42, renewsAt: new Date(Date.now() + 3600_000).toISOString() },
			}),
		};
		vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

		const { customFn, getCapturedRenderer, doneFn } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		await handler("", ctx);

		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);

		const renderer = getCapturedRenderer();
		expect(typeof renderer.handleInput).toBe("function");

		renderer.render(80);

		expect(doneFn).not.toHaveBeenCalled();
		renderer.handleInput("\x1b"); // Escape
		expect(doneFn).toHaveBeenCalledTimes(1);
	});

	it("renderer handles Enter to close", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		const mockResponse = {
			ok: true,
			json: vi.fn().mockResolvedValue({
				subscription: { limit: 100, requests: 10, renewsAt: new Date(Date.now() + 1800_000).toISOString() },
			}),
		};
		vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

		const { customFn, getCapturedRenderer, doneFn } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		await handler("", ctx);

		const renderer = getCapturedRenderer();
		expect(doneFn).not.toHaveBeenCalled();
		renderer.handleInput("\r"); // Enter
		expect(doneFn).toHaveBeenCalledTimes(1);
	});

	it("renderer handles keypad Enter to close", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		const mockResponse = {
			ok: true,
			json: vi.fn().mockResolvedValue({
				subscription: { limit: 100, requests: 10, renewsAt: new Date(Date.now() + 1800_000).toISOString() },
			}),
		};
		vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

		const { customFn, getCapturedRenderer, doneFn } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		await handler("", ctx);

		const renderer = getCapturedRenderer();
		expect(doneFn).not.toHaveBeenCalled();
		renderer.handleInput("\x1bOM"); // keypad Enter in some terminals
		expect(doneFn).toHaveBeenCalledTimes(1);
	});

	it("renderer handles normalized Escape variants to close", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		const mockResponse = {
			ok: true,
			json: vi.fn().mockResolvedValue({
				subscription: { limit: 100, requests: 10, renewsAt: new Date(Date.now() + 1800_000).toISOString() },
			}),
		};
		vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

		const { customFn, getCapturedRenderer, doneFn } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		await handler("", ctx);

		const renderer = getCapturedRenderer();
		expect(doneFn).not.toHaveBeenCalled();
		renderer.handleInput("\x1b[27;1;27~"); // xterm modifyOtherKeys Escape
		expect(doneFn).toHaveBeenCalledTimes(1);
	});

	it("opens overlay for hybrid legacy + enhanced quota responses", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		const mockResponse = {
			ok: true,
			json: vi.fn().mockResolvedValue({
				subscription: { limit: 600, requests: 0, renewsAt: new Date(Date.now() + 3600_000).toISOString() },
				search: {
					hourly: { limit: 250, requests: 0, renewsAt: new Date(Date.now() + 1800_000).toISOString() },
				},
				freeToolCalls: { limit: 0, requests: 0, renewsAt: new Date(Date.now() + 86_400_000).toISOString() },
				weeklyTokenLimit: {
					nextRegenAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
					percentRemaining: 99.9,
				},
				rollingFiveHourLimit: {
					nextTickAt: new Date(Date.now() + 10 * 60_000).toISOString(),
					tickPercent: 0.05,
					remaining: 600,
					max: 600,
					limited: false,
				},
			}),
		};
		vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

		const { customFn, getCapturedRenderer } = createCapturingCustomMock();
		const ctx = createMockCtx({}, customFn);
		await handler("", ctx);

		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		const renderer = getCapturedRenderer();
		expect(() => renderer.render(80)).not.toThrow();
	});

	it("shows error notification when quota fetch fails", async () => {
		const mockPi = createMockPi();
		registerSyntheticQuotaCommand(mockPi as unknown as ExtensionAPI);
		const handler = getHandler(mockPi, "synthetic-quota");

		vi.mocked(fetch).mockRejectedValue(new Error("Quota API down"));

		const ctx = createMockCtx();
		await handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Quota API down"), "error");
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});
});
