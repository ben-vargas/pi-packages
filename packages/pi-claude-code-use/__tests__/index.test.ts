import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piClaudeCodeUse, { _test } from "../extensions/index.js";

type MockPi = {
	registerProvider: ReturnType<typeof vi.fn>;
};

function createMockPi(): MockPi {
	return {
		registerProvider: vi.fn(),
	};
}

describe("pi-claude-code-use", () => {
	it("registers an anthropic provider override without redefining models", () => {
		const mockPi = createMockPi();
		piClaudeCodeUse(mockPi as unknown as ExtensionAPI);

		expect(mockPi.registerProvider).toHaveBeenCalledTimes(1);
		expect(mockPi.registerProvider).toHaveBeenCalledWith(
			"anthropic",
			expect.objectContaining({
				api: "anthropic-messages",
				streamSimple: expect.any(Function),
			}),
		);
	});

	it("recognizes Anthropic OAuth subscription keys", () => {
		expect(_test.isAnthropicSubscriptionAuthKey("sk-ant-oat-test")).toBe(true);
		expect(_test.isAnthropicSubscriptionAuthKey("sk-ant-api-key")).toBe(false);
		expect(_test.isAnthropicSubscriptionAuthKey(undefined)).toBe(false);
	});

	it("rewrites serialized Anthropic requests into Claude Code-compatible payloads", () => {
		const serialized = JSON.stringify({
			model: "claude-opus-4-6",
			system: [
				{
					type: "text",
					text: _test.CLAUDE_CODE_AGENT_TEXT,
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
				{
					type: "text",
					text: "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Fix the bug." }],
				},
			],
			tools: [
				{ name: "Read", description: "Read files", input_schema: { type: "object", properties: {} } },
				{ type: "web_search", name: "web_search", search_context_size: "high" },
				{ name: "web_search_exa", description: "Search web", input_schema: { type: "object", properties: {} } },
			],
		});

		const patched = _test.patchSerializedAnthropicMessagesRequest(serialized, "sk-ant-oat-test");
		expect(patched).toBeDefined();

		const transformed = JSON.parse(patched ?? "{}") as {
			metadata?: { user_id?: string };
			system: Array<{ text: string; cache_control?: { type: string; ttl?: string } }>;
			messages: Array<{ role: string; content: Array<{ type: string; text?: string; cache_control?: object }> }>;
			tools?: Array<{ name?: string; type?: string }>;
		};

		expect(transformed.metadata?.user_id).toMatch(/^user_[a-f0-9]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/);
		expect(transformed.system).toHaveLength(3);
		expect(transformed.system[0]?.text).toMatch(
			/^x-anthropic-billing-header: cc_version=2\.1\.77\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
		);
		expect(transformed.system[1]?.text).toBe(_test.CLAUDE_CODE_AGENT_TEXT);
		expect(transformed.system[2]?.text).toBe(
			"Pi documentation (read only when the user asks about the cli itself, its SDK, extensions, themes, skills, or TUI):",
		);
		expect(transformed.system[2]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(transformed.messages[0]?.content[0]?.text).toBe("Fix the bug.");
		expect(transformed.tools?.map((tool) => tool.name ?? tool.type)).toEqual(["Read", "web_search"]);
	});

	it("applies Claude Code headers to outgoing requests", () => {
		const headers = new Headers({
			"anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
			"anthropic-dangerous-direct-browser-access": "true",
			"x-stainless-helper": "mcpTool",
			"x-stainless-helper-method": "stream",
		});

		_test.applyClaudeCodeHeaders(headers, "sk-ant-oat-test", "https://api.anthropic.com/v1/messages");

		expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-test");
		expect(headers.get("user-agent")).toBe(`claude-cli/${_test.CLAUDE_CODE_VERSION} (external, cli)`);
		expect(headers.get("x-app")).toBe("cli");
		expect(headers.get("x-claude-code-session-id")).toBeTruthy();
		expect(headers.get("x-stainless-package-version")).toBe(_test.STAINLESS_PACKAGE_VERSION);
		expect(headers.get("x-stainless-runtime-version")).toBe(_test.STAINLESS_RUNTIME_VERSION);
		expect(headers.get("x-stainless-os")).toBe("MacOS");
		expect(headers.get("x-stainless-arch")).toBe("arm64");
		expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");
		expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
		expect(headers.get("anthropic-beta")).not.toContain("fine-grained-tool-streaming-2025-05-14");
		expect(headers.get("anthropic-dangerous-direct-browser-access")).toBeNull();
		expect(headers.get("x-stainless-helper")).toBeNull();
		expect(headers.get("x-stainless-helper-method")).toBeNull();
		expect(headers.get("accept-encoding")).toBe("gzip, deflate, br, zstd");
		expect(headers.get("x-client-request-id")).toBeTruthy();
	});

	it("patches requests even when fetch receives a Request object", async () => {
		const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
		const originalFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			captured.push({
				url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
				init,
			});
			return new Response("{}");
		});

		const wrappedFetch = _test.createClaudeCodeFetch("sk-ant-oat-test", originalFetch as typeof globalThis.fetch);
		const request = new Request("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				accept: "text/event-stream",
				"anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				system: [{ type: "text", text: "You are a rigorous coding assistant." }],
				messages: [{ role: "user", content: "Fix the bug." }],
			}),
		});

		await wrappedFetch(request);

		expect(originalFetch).toHaveBeenCalledTimes(1);
		expect(captured[0]?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
		const init = captured[0]?.init;
		const headers = new Headers(init?.headers);
		expect(headers.get("user-agent")).toBe(`claude-cli/${_test.CLAUDE_CODE_VERSION} (external, cli)`);
		expect(headers.get("accept-encoding")).toBe("identity");
		expect(typeof init?.body).toBe("string");
		expect(String(init?.body)).toContain("x-anthropic-billing-header:");
		expect(String(init?.body)).toContain('"user_id":"user_');
	});
});
