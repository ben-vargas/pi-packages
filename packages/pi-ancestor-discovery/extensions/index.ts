import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CONFIG_BASENAME = "pi-ancestor-discovery.json";

export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

export interface ResourceConfig {
	enabled?: boolean;
	searchPaths?: string[] | string;
}

export interface AncestorDiscoveryConfig {
	boundary?: string;
	resources?: {
		skills?: ResourceConfig;
		prompts?: ResourceConfig;
		themes?: ResourceConfig;
	};
}

export interface ResolvedResourceConfig {
	enabled: boolean;
	searchPaths: string[];
}

export interface ResolvedConfig {
	boundary: string;
	resources: {
		skills: ResolvedResourceConfig;
		prompts: ResolvedResourceConfig;
		themes: ResolvedResourceConfig;
	};
}

const DEFAULT_RESOURCES: ResolvedConfig["resources"] = {
	skills: { enabled: true, searchPaths: [".pi/skills", ".agents/skills"] },
	prompts: { enabled: false, searchPaths: [".pi/prompts"] },
	themes: { enabled: false, searchPaths: [".pi/themes"] },
};

const DEFAULT_CONFIG: AncestorDiscoveryConfig = {
	boundary: "home",
	resources: {
		skills: { enabled: true, searchPaths: [".pi/skills", ".agents/skills"] },
		prompts: { enabled: false, searchPaths: [".pi/prompts"] },
		themes: { enabled: false, searchPaths: [".pi/themes"] },
	},
};

export interface DiscoverOptions {
	cwd: string;
	boundary: string;
	resources: ResolvedConfig["resources"];
}

export function resolveBoundary(input: string | undefined, cwd: string): string {
	if (!input || input === "home" || input === "~") {
		return homedir();
	}
	if (input === "root" || input === "/") {
		return resolve("/");
	}
	const expanded = expandHome(input);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function resolveConfig(cwd: string): ResolvedConfig {
	const projectConfigPath = join(cwd, ".pi", "extensions", CONFIG_BASENAME);
	const globalConfigPath = join(homedir(), ".pi", "agent", "extensions", CONFIG_BASENAME);

	const selected = ensureDefaultConfig(projectConfigPath, globalConfigPath) ?? {};
	const boundary = resolveBoundary(selected.boundary, cwd);

	return {
		boundary,
		resources: {
			skills: resolveResourceConfig(selected.resources?.skills, DEFAULT_RESOURCES.skills),
			prompts: resolveResourceConfig(selected.resources?.prompts, DEFAULT_RESOURCES.prompts),
			themes: resolveResourceConfig(selected.resources?.themes, DEFAULT_RESOURCES.themes),
		},
	};
}

export function discoverResources(options: DiscoverOptions): {
	skillPaths: string[];
	promptPaths: string[];
	themePaths: string[];
} {
	const ancestors = discoverAncestorDirs(options.cwd, options.boundary);

	const skillPaths = options.resources.skills.enabled
		? collectPaths({
				ancestors,
				searchPaths: options.resources.skills.searchPaths,
			})
		: [];

	const promptPaths = options.resources.prompts.enabled
		? collectPaths({
				ancestors,
				searchPaths: options.resources.prompts.searchPaths,
			})
		: [];

	const themePaths = options.resources.themes.enabled
		? collectPaths({
				ancestors,
				searchPaths: options.resources.themes.searchPaths,
			})
		: [];

	return { skillPaths, promptPaths, themePaths };
}

export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", (event) => {
		const cwd = event.cwd ?? process.cwd();
		const config = resolveConfig(cwd);
		return discoverResources({
			cwd,
			boundary: config.boundary,
			resources: config.resources,
		});
	});
}

function readConfigFile(filePath: string): AncestorDiscoveryConfig | null {
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as AncestorDiscoveryConfig;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-ancestor-discovery] Failed to read ${filePath}: ${message}`);
		return null;
	}
}

function ensureDefaultConfig(projectConfigPath: string, globalConfigPath: string): AncestorDiscoveryConfig | null {
	const projectConfig = readConfigFile(projectConfigPath);
	if (projectConfig) {
		return projectConfig;
	}

	const globalConfig = readConfigFile(globalConfigPath);
	if (globalConfig) {
		return globalConfig;
	}

	try {
		mkdirSync(dirname(globalConfigPath), { recursive: true });
		writeFileSync(globalConfigPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
		return DEFAULT_CONFIG;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-ancestor-discovery] Failed to write ${globalConfigPath}: ${message}`);
		return DEFAULT_CONFIG;
	}
}

function resolveResourceConfig(
	input: ResourceConfig | undefined,
	defaults: ResolvedResourceConfig,
): ResolvedResourceConfig {
	const enabled = input?.enabled ?? defaults.enabled;
	const normalized = normalizeSearchPaths(input?.searchPaths);
	const searchPaths = normalized.length > 0 ? normalized : [...defaults.searchPaths];
	return { enabled, searchPaths };
}

function normalizeSearchPaths(input?: string[] | string): string[] {
	const raw = Array.isArray(input) ? input : input ? [input] : [];
	const values: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		values.push(trimmed);
	}
	return values;
}

function discoverAncestorDirs(cwd: string, boundary: string): string[] {
	const resolvedCwd = resolve(cwd);
	const resolvedBoundary = resolve(boundary);
	const ancestors: string[] = [];
	let current = resolvedCwd;

	while (true) {
		ancestors.push(current);
		if (current === resolvedBoundary) {
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return ancestors;
}

function collectPaths(options: { ancestors: string[]; searchPaths: string[] }): string[] {
	const { ancestors, searchPaths } = options;
	const results: string[] = [];
	const seen = new Set<string>();
	const relativeSearch: string[] = [];
	const absoluteSearch: string[] = [];

	for (const raw of searchPaths) {
		const expanded = expandHome(raw);
		if (isAbsolute(expanded)) {
			absoluteSearch.push(expanded);
		} else {
			relativeSearch.push(raw);
		}
	}

	for (const ancestor of ancestors) {
		for (const rel of relativeSearch) {
			const candidate = resolve(ancestor, rel);
			if (!existsSync(candidate)) continue;
			const normalized = resolve(candidate);
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			results.push(normalized);
		}
	}

	for (const abs of absoluteSearch) {
		const candidate = resolve(abs);
		if (!existsSync(candidate)) continue;
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		results.push(candidate);
	}

	return results;
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	if (input.startsWith("~")) return join(homedir(), input.slice(1));
	return input;
}

export const _test = {
	discoverAncestorDirs,
	normalizeSearchPaths,
	collectPaths,
	readConfigFile,
	ensureDefaultConfig,
	resolveResourceConfig,
	expandHome,
	DEFAULT_CONFIG,
	DEFAULT_RESOURCES,
};
