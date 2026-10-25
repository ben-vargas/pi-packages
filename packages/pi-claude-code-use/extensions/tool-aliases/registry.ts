import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPlainObject, loadConfig, lower } from "../shared.js";
import { remapBlockNames } from "./payload.js";
import { renderCompactAliasResult } from "./render.js";
import {
	type AliasSourceMeta,
	activationState,
	aliasAssignments,
	aliasExactNames,
	aliasSourceMeta,
	autoActivatedAliases,
	CORE_TOOL_NAMES,
	FLAT_TO_MCP,
	GENERIC_DIR_NAMES,
	MAX_TOOL_NAME_LENGTH,
	MCP_TO_FLAT,
	refreshAliasMap,
	registeredAliasRoutes,
	registeredMcpAliases,
	type ToolAliasPair,
	type ToolInfo,
	type ToolRegistration,
} from "./state.js";

// ============================================================================
// User-defined tool aliases ("toolAliases" in pi-claude-code-use.json)
//
// Entries act as overrides on top of automatic alias derivation: when a flat
// tool name appears here, the configured MCP name is used instead of the
// derived one.
// ============================================================================

// Returns `undefined` when `toolAliases` is missing or not an array; returns
// `[]` for an explicit empty array (which disables inherited globals).
export function extractToolAliasPairs(value: unknown): ToolAliasPair[] | undefined {
	if (!isPlainObject(value)) return undefined;
	const raw = (value as { toolAliases?: unknown }).toolAliases;
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		console.warn(`[pi-claude-code-use] Ignoring "toolAliases": expected array, got ${typeof raw}`);
		return undefined;
	}
	return raw.filter(
		(e): e is ToolAliasPair => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string",
	);
}

export function loadToolAliases(cwd: string, agentDir?: string): ToolAliasPair[] {
	return extractToolAliasPairs(loadConfig(cwd, agentDir)) ?? [];
}

// Rewrite MCP-aliased `toolCall.name`s in the finalized assistant message
// back to their canonical flat names. Fires from `message_end`, which runs
// BEFORE the agent loop resolves which tool to invoke — so Pi looks up the
// ORIGINAL extension's `execute` (preserving its closure-bound state) instead
// of this extension's schema-only alias stub. Inverse of `remapMessageToolNames`.
//
// Gated on `registeredMcpAliases`: only rewrites names that this extension
// explicitly registered, so foreign mcp__ tools (owned by other extensions)
// pass through untouched.
export function unaliasToolCalls(message: unknown): unknown {
	if (!isPlainObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
		return undefined;
	}
	const content = remapBlockNames(message.content, "toolCall", (n) => {
		const nameLc = lower(n);
		if (!registeredMcpAliases.has(nameLc)) return undefined;
		// Prefer the current mapping; fall back to the permanent route recorded at
		// registration time so stale aliases (e.g. after a config change removed
		// their mapping) still resolve to their original flat tool.
		return MCP_TO_FLAT.get(nameLc) ?? registeredAliasRoutes.get(nameLc);
	});
	return content === message.content ? undefined : { ...message, content };
}

// ============================================================================
// MCP alias derivation
//
// Anthropic's OAuth endpoint accepts any name shaped like mcp__<server>__<tool>,
// which is what made aliasing work while flat names were refused. Instead of maintaining a
// hardcoded list of known extensions, every non-core flat tool reported by
// pi.getAllTools() gets a deterministic MCP-style alias derived from its
// sourceInfo (the extension it came from) and its tool name.
// ============================================================================

/** Sanitize a name fragment into a lowercase [a-z0-9_] segment. */
export function sanitizeAliasSegment(value: string, fallback: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned.length > 0 ? cleaned : fallback;
}

/** Strip a leading "pi-"/"pi_" prefix from an extension/package name. */
function stripPiPrefix(name: string): string {
	return name.replace(/^pi[-_]/i, "");
}

/**
 * Derive the `<server>` segment of an MCP alias from a tool's sourceInfo.
 *
 * Priority:
 * 1. Synthetic sources (`<builtin:...>`, `<sdk:...>`) → "pi".
 * 2. npm installs → unscoped package name from the node_modules path.
 * 3. Single-file extensions → file stem (when not "index").
 * 4. Directory-based extensions → nearest non-generic directory name
 *    (skipping extensions/src/dist/lib/build/out), falling back to baseDir.
 */
export function deriveServerSegment(sourceInfo: ToolInfo["sourceInfo"] | undefined): string {
	const rawPath = (sourceInfo?.path ?? "").replaceAll("\\", "/");
	if (!rawPath || rawPath.startsWith("<")) return "pi";

	// npm install: use the package name from the node_modules path.
	const nmIdx = rawPath.lastIndexOf("/node_modules/");
	if (nmIdx !== -1) {
		const segments = rawPath
			.slice(nmIdx + "/node_modules/".length)
			.split("/")
			.filter(Boolean);
		const pkg = segments[0]?.startsWith("@") ? segments[1] : segments[0];
		if (pkg) return sanitizeAliasSegment(stripPiPrefix(pkg), "ext");
	}

	const segments = rawPath.split("/").filter(Boolean);
	const fileName = segments.pop() ?? "";

	// Single-file extension: use the file stem when it is meaningful.
	const stem = fileName.replace(/\.[^.]*$/, "");
	if (stem && stem !== "index") return sanitizeAliasSegment(stripPiPrefix(stem), "ext");

	// Walk up past generic build/source directory names.
	while (segments.length > 0 && GENERIC_DIR_NAMES.has(segments[segments.length - 1] ?? "")) {
		segments.pop();
	}
	const dirName = segments[segments.length - 1];
	if (dirName && !/^[a-zA-Z]:$/.test(dirName)) return sanitizeAliasSegment(stripPiPrefix(dirName), "ext");

	return "ext";
}

/** Derive the base (pre-collision-handling) MCP alias for a tool. */
export function deriveAliasBase(tool: ToolInfo): string {
	const server = deriveServerSegment(tool.sourceInfo);
	const toolSegment = sanitizeAliasSegment(tool.name, "tool");
	return `mcp__${server}__${toolSegment}`;
}

/**
 * Resolve `base` against `taken` (lowercase name set), appending a numeric
 * suffix (`_2`, `_3`, ...) on collision. The result always fits Anthropic's
 * 128-char tool name limit. Deterministic for a given base + taken set.
 */
export function reserveAliasName(base: string, taken: Set<string>): string {
	let candidate = base.slice(0, MAX_TOOL_NAME_LENGTH);
	let counter = 2;
	while (taken.has(lower(candidate))) {
		const suffix = `_${counter}`;
		candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
		counter += 1;
	}
	return candidate;
}

// ============================================================================
// MCP alias registration
//
// At session start and before each agent turn, reads the live tool registry
// via pi.getAllTools() and registers a schema-only MCP alias for every
// non-core flat tool. This includes tools that other extensions register from
// lifecycle hooks (e.g. pi-web-providers), which a static capture of the
// extension factory would miss.
//
// Alias tools carry the source tool's schema, description, and prompt
// guidelines, but a stub execute: managed alias calls are rewritten back to
// their flat source names at `message_end` before Pi resolves execution, so
// the ORIGINAL extension's execute always runs.
// ============================================================================

/**
 * Promote auto-activated aliases to user-selected when the user deliberately
 * kept the alias while removing its flat counterpart from the tool picker.
 * Detected via the last managed baseline: the flat tool was previously
 * managed, is no longer active, and the alias is still active. Comparisons
 * are case-insensitive (FLAT_TO_MCP keys are lowercased; pi names are exact).
 */
function promoteKeptAliases(activeNames: string[], desiredSet: ReadonlySet<string>): void {
	if (activationState.lastManagedToolList === undefined) return;
	const activeSet = new Set(activeNames);
	const activeLc = new Set(activeNames.map(lower));
	const lastManagedLc = new Set(activationState.lastManagedToolList.map(lower));
	for (const alias of [...autoActivatedAliases]) {
		if (!activeSet.has(alias) || desiredSet.has(alias)) continue;
		const flatLc = [...FLAT_TO_MCP.entries()].find(([, mcp]) => mcp === alias)?.[0];
		if (flatLc && lastManagedLc.has(flatLc) && !activeLc.has(flatLc)) {
			autoActivatedAliases.delete(alias);
		}
	}
}

export function registerMcpAliases(pi: ExtensionAPI, opts: { cwd?: string; agentDir?: string } = {}): void {
	// Pick up user-defined tool aliases so subsequent payload transforms
	// (filterAndRemapTools, remapToolChoice, message rewriting) see them.
	const userToolAliases = loadToolAliases(opts.cwd ?? process.cwd(), opts.agentDir);
	const disableAutoAlias = process.env.PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS === "1";

	const allTools = pi.getAllTools();
	const toolIndex = new Map<string, ToolInfo>();
	for (const tool of allTools) {
		toolIndex.set(lower(tool.name), tool);
	}

	// Names unavailable for newly derived aliases: every currently registered
	// tool plus every valid user-configured alias target.
	const taken = new Set(toolIndex.keys());

	// Aliasable tools, in deterministic order so collision suffixes are stable.
	const aliasable = allTools
		.filter((tool) => {
			const nameLc = lower(tool.name);
			return nameLc.length > 0 && !CORE_TOOL_NAMES.has(nameLc) && !nameLc.startsWith("mcp__");
		})
		.sort((a, b) => (lower(a.name) < lower(b.name) ? -1 : 1));

	// Case-insensitive duplicate flat names are excluded from aliasing (and
	// from user overrides): all alias state is keyed by lowercased names while
	// pi's execution lookup is exact-name, so aliasing either variant could
	// route a call for one tool to the other.
	const flatNameCounts = new Map<string, number>();
	for (const tool of aliasable) {
		const flatLc = lower(tool.name);
		flatNameCounts.set(flatLc, (flatNameCounts.get(flatLc) ?? 0) + 1);
	}
	const isDuplicateFlat = (flatLc: string): boolean => (flatNameCounts.get(flatLc) ?? 0) > 1;

	// Validate user overrides. Invalid entries are fully ignored: they are
	// excluded from registration AND from the alias maps, so derivation and
	// payload remapping fall back to the derived alias.
	const warnIgnored = (flat: string, mcp: string, reason: string): void => {
		console.warn(`[pi-claude-code-use] Ignoring toolAliases entry ["${flat}", "${mcp}"]: ${reason}`);
	};
	const validUserAliases: ToolAliasPair[] = [];
	const userOverrides = new Map<string, string>();
	const overrideTargets = new Set<string>();
	for (const [flat, mcp] of userToolAliases) {
		const mcpLc = lower(mcp);
		if (isDuplicateFlat(lower(flat))) {
			warnIgnored(flat, mcp, "flat tool name has a case-insensitive duplicate in the registry");
			continue;
		}
		if (mcp !== mcp.trim()) {
			warnIgnored(flat, mcp, "alias has surrounding whitespace");
			continue;
		}
		if (!mcpLc.startsWith("mcp__")) {
			warnIgnored(flat, mcp, 'alias must start with "mcp__"');
			continue;
		}
		if (mcp.length > MAX_TOOL_NAME_LENGTH) {
			warnIgnored(flat, mcp, `alias exceeds ${MAX_TOOL_NAME_LENGTH} characters`);
			continue;
		}
		if (overrideTargets.has(mcpLc)) {
			warnIgnored(flat, mcp, "alias is already used by another toolAliases entry");
			continue;
		}
		// The target may already exist as a tool only when this extension
		// registered it for the same flat tool. A foreign tool with that name, or
		// an alias we registered for a DIFFERENT flat tool, must not be re-routed.
		const ownedFor = registeredAliasRoutes.get(mcpLc);
		if (toolIndex.has(mcpLc) && !registeredMcpAliases.has(mcpLc)) {
			warnIgnored(flat, mcp, "alias name is already taken by another extension's tool");
			continue;
		}
		if (ownedFor !== undefined && lower(ownedFor) !== lower(flat)) {
			warnIgnored(flat, mcp, `alias is already registered for "${ownedFor}"`);
			continue;
		}
		validUserAliases.push([flat, mcp]);
		userOverrides.set(lower(flat), mcp);
		overrideTargets.add(mcpLc);
		taken.add(mcpLc);
	}

	const registerAliasTool = (tool: ToolInfo, mcpName: string): void => {
		const mcpLc = lower(mcpName);
		const meta: AliasSourceMeta = {
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
			// Pi 0.99+ reports exposure; older releases omit it.
			exposure: tool.exposure,
		};
		if (registeredMcpAliases.has(mcpLc)) {
			// Re-register when the source tool's metadata changed (e.g. the source
			// extension re-registered it with a new schema from a lifecycle hook)
			// or when the exact alias casing changed (pi keys tools by exact name).
			const previous = aliasSourceMeta.get(mcpLc);
			if (
				previous &&
				previous.description === meta.description &&
				previous.parameters === meta.parameters &&
				previous.promptGuidelines === meta.promptGuidelines &&
				previous.exposure === meta.exposure &&
				aliasExactNames.get(mcpLc) === mcpName
			) {
				return;
			}
		} else if (toolIndex.has(mcpLc)) {
			// Never shadow an existing tool (e.g. a real MCP tool from another extension).
			return;
		}
		// Pi keys tool registrations by EXACT name and auto-activates newly
		// introduced exact names, so a case-only alias change also counts as a
		// new registration for provenance tracking.
		const isNewExactName = aliasExactNames.get(mcpLc) !== mcpName;
		pi.registerTool({
			name: mcpName,
			label: `MCP ${tool.name}`,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
			// Aliases are declared to the model but never callable (Pi 0.99+): other
			// tools and codemode scripts reach the source tool itself, with its output
			// schema and execution, instead of a schema-only stub. A withdrawn (hidden)
			// source withdraws its alias. Older releases ignore `exposure`.
			exposure: meta.exposure === "hidden" ? "hidden" : "model-only",
			renderResult(result, { expanded, isPartial }, theme, context) {
				return renderCompactAliasResult(result.content, { expanded, isPartial }, theme, context.showImages);
			},
			async execute() {
				// Managed alias calls are rewritten back to the flat tool name at
				// message_end before Pi resolves execution, and model-only aliases are
				// not callable by other tools, so this stub only runs if that rewrite
				// was somehow bypassed.
				throw new Error(
					`Tool alias "${mcpName}" was invoked directly; pi-claude-code-use should have routed it to "${tool.name}".`,
				);
			},
		} as ToolRegistration);
		registeredMcpAliases.add(mcpLc);
		registeredAliasRoutes.set(mcpLc, tool.name);
		aliasSourceMeta.set(mcpLc, meta);
		aliasExactNames.set(mcpLc, mcpName);
		// Pi auto-activates newly registered tool NAMES (not same-name
		// re-registrations, which preserve activation). Track only new exact
		// names as auto-managed so syncAliasActivation can deactivate them when
		// OAuth is off or the flat source tool is inactive, without flipping the
		// provenance of a user-selected alias whose source schema merely changed.
		if (isNewExactName) {
			autoActivatedAliases.add(mcpName);
		}
	};

	const derivedPairs: ToolAliasPair[] = [];
	for (const tool of aliasable) {
		const flatLc = lower(tool.name);
		if (isDuplicateFlat(flatLc)) {
			console.warn(`[pi-claude-code-use] Not aliasing "${tool.name}": case-insensitive duplicate tool name`);
			continue;
		}

		const override = userOverrides.get(flatLc);
		if (override) {
			registerAliasTool(tool, override);
			continue; // Mapping comes from validUserAliases in refreshAliasMap.
		}
		if (disableAutoAlias) continue;

		// Reuse the previous derived assignment when we registered it; otherwise derive.
		let mcpName = aliasAssignments.get(flatLc);
		if (!mcpName || (!registeredMcpAliases.has(lower(mcpName)) && taken.has(lower(mcpName)))) {
			mcpName = reserveAliasName(deriveAliasBase(tool), taken);
		}
		taken.add(lower(mcpName));
		aliasAssignments.set(flatLc, mcpName);
		derivedPairs.push([tool.name, mcpName]);
		registerAliasTool(tool, mcpName);
	}

	refreshAliasMap(validUserAliases, derivedPairs);
}

/**
 * Synchronize MCP alias tool activation with the current model state.
 * When OAuth is active, auto-activate aliases for any active flat source tools.
 * When OAuth is inactive, remove auto-activated aliases (but preserve user-selected ones).
 */
export function syncAliasActivation(pi: ExtensionAPI, enableAliases: boolean): void {
	const activeNames = pi.getActiveTools();
	const allNames = new Set(pi.getAllTools().map((t) => t.name));

	if (enableAliases) {
		// Determine which aliases should be active based on their flat counterpart being active
		const activeLc = new Set(activeNames.map(lower));
		const desiredAliases: string[] = [];
		for (const [flat, mcp] of FLAT_TO_MCP) {
			if (activeLc.has(flat) && allNames.has(mcp) && registeredMcpAliases.has(lower(mcp))) {
				desiredAliases.push(mcp);
			}
		}
		const desiredSet = new Set(desiredAliases);

		promoteKeptAliases(activeNames, desiredSet);

		// Find registered aliases currently in the active list
		const activeRegistered = activeNames.filter((n) => registeredMcpAliases.has(lower(n)) && allNames.has(n));

		// Per-alias provenance: an alias is "user-selected" if it's active and was NOT
		// auto-activated by us. Only preserve those; auto-activated aliases get re-derived
		// from the desired set each sync.
		const preserved = activeRegistered.filter((n) => !autoActivatedAliases.has(n));

		// Build result: non-alias tools + preserved user aliases + desired aliases
		const nonAlias = activeNames.filter((n) => !registeredMcpAliases.has(lower(n)));
		const next = Array.from(new Set([...nonAlias, ...preserved, ...desiredAliases]));

		// Update auto-activation tracking: aliases we added this sync that weren't user-preserved
		const preservedSet = new Set(preserved);
		autoActivatedAliases.clear();
		for (const name of desiredAliases) {
			if (!preservedSet.has(name)) {
				autoActivatedAliases.add(name);
			}
		}

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
		}
		// Record the managed state even when nothing changed (pi may have
		// auto-activated a fresh alias, making the first sync a no-op). The
		// promote-to-user-selected logic needs this baseline to recognize a
		// user's later picker changes.
		activationState.lastManagedToolList = [...next];
	} else {
		// A user may have removed a flat tool while keeping its alias and then
		// switched away from OAuth before another enabled sync ran; honor that
		// choice here too before pruning.
		promoteKeptAliases(activeNames, new Set());

		// Remove only auto-activated aliases; user-selected ones are preserved
		const next = activeNames.filter((n) => !autoActivatedAliases.has(n));
		autoActivatedAliases.clear();

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
			activationState.lastManagedToolList = [...next];
		} else {
			activationState.lastManagedToolList = undefined;
		}
	}
}
