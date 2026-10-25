import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function lower(name: string | undefined): string {
	return (name ?? "").trim().toLowerCase();
}

// ============================================================================
// Configuration (pi-claude-code-use.json)
//
//   - project: <cwd>/.pi/extensions/pi-claude-code-use.json
//   - global:  <agentDir>/extensions/pi-claude-code-use.json   (agentDir from pi)
//
// Project file's keys replace global file's via spread-merge — same effective
// behaviour as pi-core's deepMergeSettings for top-level keys.
// Schema: { "toolAliasing": boolean, "toolAliases": [[flat, mcp], ...] }
// ============================================================================

const CONFIG_FILENAME = "pi-claude-code-use.json";

function readConfigFile(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		return isPlainObject(parsed) ? parsed : {};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-claude-code-use] Failed to read ${filePath}: ${message}`);
		return {};
	}
}

/** Global config overlaid with the project config. */
export function loadConfig(cwd: string, agentDir: string = getAgentDir()): Record<string, unknown> {
	return {
		...readConfigFile(join(agentDir, "extensions", CONFIG_FILENAME)),
		...readConfigFile(join(cwd, ".pi", "extensions", CONFIG_FILENAME)),
	};
}

/**
 * Tool aliasing is opt-in. `PI_CLAUDE_CODE_USE_TOOL_ALIASES=1` or `=0` wins;
 * otherwise `"toolAliasing": true` in the config enables it.
 */
export function isToolAliasingEnabled(cwd: string, agentDir?: string): boolean {
	const env = process.env.PI_CLAUDE_CODE_USE_TOOL_ALIASES;
	if (env === "1") return true;
	if (env === "0") return false;
	return loadConfig(cwd, agentDir).toolAliasing === true;
}
