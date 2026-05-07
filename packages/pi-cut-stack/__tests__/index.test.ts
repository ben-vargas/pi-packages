import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piCutStack from "../extensions/index.js";

const createMockPi = () =>
	({
		registerShortcut: vi.fn(),
	}) satisfies Partial<ExtensionAPI>;

function withTempAgentDir<T>(fn: (agentDir: string) => T): T {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-cut-stack-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return fn(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	}
}

describe("pi-cut-stack", () => {
	it("registers default shortcuts when no keybindings file exists", () => {
		withTempAgentDir(() => {
			const mockPi = createMockPi();
			piCutStack(mockPi as unknown as ExtensionAPI);

			const shortcutKeys = mockPi.registerShortcut.mock.calls.map(([key]) => key);
			expect(shortcutKeys).toEqual(expect.arrayContaining(["alt+x", "alt+p"]));
		});
	});

	it("registers configured shortcuts from keybindings file", () => {
		withTempAgentDir((agentDir) => {
			writeFileSync(
				join(agentDir, "keybindings.json"),
				JSON.stringify(
					{
						"ext.pi-cut-stack.cut": "ctrl+k",
						"ext.pi-cut-stack.pop": ["alt+y", "alt+z"],
					},
					null,
					2,
				),
				"utf-8",
			);

			const mockPi = createMockPi();
			piCutStack(mockPi as unknown as ExtensionAPI);

			const shortcutKeys = mockPi.registerShortcut.mock.calls.map(([key]) => key);
			expect(shortcutKeys).toEqual(expect.arrayContaining(["ctrl+k", "alt+y", "alt+z"]));
		});
	});
});
