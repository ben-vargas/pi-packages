import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	AgentSession,
	createAgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piModelSort from "../extensions/index.js";

// The extension resolves its config path from getAgentDir() at import time, so
// the agent dir has to point at a scratch directory before the module loads.
const agentDir = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "pi-model-sort-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type CycleFn = (this: unknown, ...args: unknown[]) => Promise<unknown>;

const proto = AgentSession.prototype as unknown as Record<string, unknown>;
const realCycleScopedModel = proto._cycleScopedModel as CycleFn;

function createMockPi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, handler);
		}),
		setModel: vi.fn(async () => true),
		setThinkingLevel: vi.fn(),
		getThinkingLevel: vi.fn(() => "medium"),
	};
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

function createMockContext(): ExtensionContext {
	return {
		model: { provider: "openai", id: "gpt-5.6-sol" },
		modelRegistry: {
			getAvailable: () => [],
			getAll: () => [],
			find: () => undefined,
			hasConfiguredAuth: () => false,
		},
		sessionManager: { buildContextEntries: () => [] },
	} as unknown as ExtensionContext;
}

function scoped(provider: string, id: string) {
	return { model: { provider, id } };
}

describe("AgentSession._cycleScopedModel patch", () => {
	let cycleSpy: ReturnType<typeof vi.fn<CycleFn>>;
	let handlers: Map<string, Handler>;
	const ctx = createMockContext();

	beforeEach(async () => {
		// Stand in for pi's private method so the wrapper can be observed without
		// building a full AgentSession. Installed before session_start so the
		// extension captures the spy as the original it delegates to.
		cycleSpy = vi.fn<CycleFn>(async function (this: unknown) {
			return { cycled: true, scopedAtCall: [...(this as { _scopedModels: unknown[] })._scopedModels] };
		});
		proto._cycleScopedModel = cycleSpy;
		const mock = createMockPi();
		handlers = mock.handlers;
		piModelSort(mock.pi);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(proto._cycleScopedModel).not.toBe(cycleSpy);
	});

	afterEach(() => {
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		expect(proto._cycleScopedModel).toBe(cycleSpy);
		proto._cycleScopedModel = realCycleScopedModel;
	});

	// pi 0.84.3+ (#5263) added a second `options: ModelMutationOptions`
	// parameter and reads `options.persist` once a next model is selected, so a
	// wrapper that forwards only `direction` makes every model-changing Ctrl+P
	// throw "Cannot read properties of undefined (reading 'persist')".
	it("forwards every argument to pi's original when sorting the scope", async () => {
		const patched = proto._cycleScopedModel as CycleFn;
		const session = { _scopedModels: [scoped("openai", "gpt-5.6-sol"), scoped("anthropic", "claude-fable-5")] };
		const options = { persist: true };

		await patched.call(session, "backward", options);

		expect(cycleSpy).toHaveBeenCalledTimes(1);
		expect(cycleSpy.mock.calls[0]).toEqual(["backward", options]);
		expect(cycleSpy.mock.calls[0][1]).toBe(options);
	});

	it("forwards every argument when the scope is too small to sort", async () => {
		const patched = proto._cycleScopedModel as CycleFn;
		const session = { _scopedModels: [scoped("openai", "gpt-5.6-sol")] };

		await patched.call(session, "forward", {});

		expect(cycleSpy.mock.calls[0]).toEqual(["forward", {}]);
	});

	it("sorts the scope by last use for the cycle lookup and restores the configured order", async () => {
		const patched = proto._cycleScopedModel as CycleFn;
		const configured = [scoped("openai", "gpt-5.6-sol"), scoped("anthropic", "claude-fable-5")];
		const session = { _scopedModels: configured };

		await handlers.get("model_select")?.(
			{ type: "model_select", model: { provider: "anthropic", id: "claude-fable-5" }, source: "set" },
			ctx,
		);
		const result = (await patched.call(session, "forward", {})) as { scopedAtCall: unknown[] };

		expect(result.scopedAtCall.map((entry) => (entry as { model: { id: string } }).model.id)).toEqual([
			"claude-fable-5",
			"gpt-5.6-sol",
		]);
		expect(session._scopedModels).toBe(configured);
	});
});

// Runs pi's real AgentSession._cycleScopedModel (installed pi-coding-agent)
// through the wrapper: a real session built with the SDK, two scoped models
// made "available" by stubbed provider keys, no network (PI_OFFLINE, no turn).
describe("scoped cycling through pi's real AgentSession", () => {
	let handlers: Map<string, Handler>;
	let session: AgentSession;
	const ctx = createMockContext();
	const cwd = join(agentDir, "cwd");

	beforeEach(async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
		mkdirSync(cwd, { recursive: true });

		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		const sol = modelRuntime.getModel("openai", "gpt-5.6-sol");
		const fable = modelRuntime.getModel("anthropic", "claude-fable-5");
		if (!sol || !fable) throw new Error("expected built-in models in the installed pi catalog");

		const mock = createMockPi();
		handlers = mock.handlers;
		piModelSort(mock.pi);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(proto._cycleScopedModel).not.toBe(realCycleScopedModel);

		session = (
			await createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				model: sol,
				thinkingLevel: "medium",
				scopedModels: [{ model: sol }, { model: fable }],
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager: SettingsManager.inMemory(),
				noTools: "all",
			})
		).session;
	});

	afterEach(() => {
		session.dispose();
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		expect(proto._cycleScopedModel).toBe(realCycleScopedModel);
		vi.unstubAllEnvs();
	});

	it("cycles to the other scoped model without throwing", async () => {
		expect(session.model?.id).toBe("gpt-5.6-sol");

		const result = await session.cycleModel("forward");

		expect(result).toMatchObject({ isScoped: true, model: { provider: "anthropic", id: "claude-fable-5" } });
		expect(session.model?.id).toBe("claude-fable-5");
		// The configured scope order is restored after the lookup.
		expect(session.scopedModels.map((entry) => entry.model.id)).toEqual(["gpt-5.6-sol", "claude-fable-5"]);
	});

	it("cycles back and forth across both models", async () => {
		await session.cycleModel("forward");
		const back = await session.cycleModel("backward");

		expect(back?.model.id).toBe("gpt-5.6-sol");
		expect(session.model?.id).toBe("gpt-5.6-sol");
	});
});

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});
