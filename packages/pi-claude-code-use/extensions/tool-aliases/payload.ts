import { isPlainObject, lower } from "../shared.js";
import { CORE_TOOL_NAMES, FLAT_TO_MCP, PI_DEFERRED_PLACEHOLDER, registeredMcpAliases } from "./state.js";

// Rewrite `name` on every block of `blockType` via `mapName`. Returns the
// SAME array reference when nothing changed, so callers can use reference
// equality to skip spreading the parent object.
export function remapBlockNames(
	content: unknown[],
	blockType: "tool_use" | "toolCall",
	mapName: (name: string) => string | undefined,
): unknown[] {
	let changed = false;
	const next = content.map((block) => {
		if (!isPlainObject(block) || block.type !== blockType || typeof block.name !== "string") {
			return block;
		}
		const newName = mapName(block.name);
		if (!newName || newName === block.name) return block;
		changed = true;
		return { ...block, name: newName };
	});
	return changed ? next : content;
}

// ============================================================================
// Tool filtering and MCP alias remapping
//
// Rules applied per tool:
// 1. Anthropic-native typed tools and Pi's deferred placeholder → pass through
// 2. Core Claude Code tool names → pass through
// 3. Tools already prefixed with mcp__ → pass through
// 4. Aliased flat tools whose MCP alias is also advertised → rename to alias
// 5. Aliased flat tools without an advertised alias → filtered out
// 6. Unknown flat-named tools → filtered out (unless disableFilter)
// ============================================================================

export function collectToolNames(tools: unknown[]): Set<string> {
	const names = new Set<string>();
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === "string") {
			names.add(lower(tool.name));
		}
	}
	return names;
}

function collectToolsByName(tools: unknown[]): Map<string, Record<string, unknown>> {
	const byName = new Map<string, Record<string, unknown>>();
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === "string") {
			byName.set(lower(tool.name), tool);
		}
	}
	return byName;
}

/**
 * Wire name for a tool declared outside the top-level list (Pi 1.x inline
 * `tool_addition` definitions), following rules 2-6 above: core and mcp__ names
 * pass through, flat tools take a known alias, and other flat tools are dropped.
 */
function projectDeclaredToolName(name: string, advertised: ReadonlySet<string>): string | undefined {
	const nameLc = lower(name);
	if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) return name;
	const mcpAlias = FLAT_TO_MCP.get(nameLc);
	if (!mcpAlias) return undefined;
	const aliasLc = lower(mcpAlias);
	return advertised.has(aliasLc) || registeredMcpAliases.has(aliasLc) ? mcpAlias : undefined;
}

/**
 * Aliases whose flat source is active in Pi but absent from the request. Pi
 * leaves out declarations that a loadout hook hides (codemode's "only" mode
 * hides active direct tools). Model-only aliases are not hidden with them, so
 * they follow their source here. An alias kept active while its source is
 * inactive is a deliberate user selection and stays declared.
 */
function findHiddenSourceAliases(payload: Record<string, unknown>, activeToolNames: readonly string[]): Set<string> {
	const declared = collectToolNames(Array.isArray(payload.tools) ? payload.tools : []);
	if (Array.isArray(payload.messages)) {
		for (const msg of payload.messages) {
			if (!isPlainObject(msg) || msg.role !== "system" || !Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (isToolChangeBlock(block) && block.type === "tool_addition") declared.add(lower(getToolChangeName(block)));
			}
		}
	}
	const hidden = new Set<string>();
	for (const name of activeToolNames) {
		const nameLc = lower(name);
		const alias = FLAT_TO_MCP.get(nameLc);
		if (alias && registeredMcpAliases.has(lower(alias)) && !declared.has(nameLc)) hidden.add(lower(alias));
	}
	return hidden;
}

export function filterAndRemapTools(
	tools: unknown[] | undefined,
	disableFilter: boolean,
	hiddenAliases: ReadonlySet<string> = new Set(),
): unknown[] | undefined {
	if (!Array.isArray(tools)) return tools;

	const advertised = collectToolNames(tools);
	const toolsByName = collectToolsByName(tools);
	const emitted = new Set<string>();
	const result: unknown[] = [];

	// Aliases (lowercase) that a flat entry in this payload will be renamed to.
	// Prefer the flat entry's current schema over the advertised alias stub.
	// If only the alias was active initially, retain its original position.
	const replacedByFlat = new Set<string>();
	const initialAliasReplacements = new Map<string, Record<string, unknown>>();
	if (!disableFilter) {
		for (const tool of tools) {
			if (!isPlainObject(tool) || typeof tool.name !== "string") continue;
			if (typeof tool.type === "string" && tool.type.trim().length > 0) continue;
			const nameLc = lower(tool.name);
			if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) continue;
			const mcpAlias = FLAT_TO_MCP.get(nameLc);
			if (!mcpAlias) continue;
			const aliasLc = lower(mcpAlias);
			if (advertised.has(aliasLc) || registeredMcpAliases.has(aliasLc)) {
				replacedByFlat.add(aliasLc);
				const advertisedAlias = toolsByName.get(aliasLc);
				if (tool.defer_loading === true && advertisedAlias && advertisedAlias.defer_loading !== true) {
					// The alias was active before the flat source was declared. Keep
					// its initial position and activation while using the source schema.
					const renamed: Record<string, unknown> = { ...tool, name: mcpAlias };
					delete renamed.defer_loading;
					if (advertisedAlias.cache_control !== undefined) renamed.cache_control = advertisedAlias.cache_control;
					initialAliasReplacements.set(aliasLc, renamed);
				}
			}
		}
	}

	for (const tool of tools) {
		if (!isPlainObject(tool)) continue;

		// The placeholder is created by Pi's transport, not the extension tool
		// registry. Keep its name, schema, position, and deferred state unchanged.
		if (
			(typeof tool.type === "string" && tool.type.trim().length > 0) ||
			(tool.name === PI_DEFERRED_PLACEHOLDER && tool.defer_loading === true)
		) {
			result.push(tool);
			continue;
		}

		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const nameLc = lower(name);

		if (hiddenAliases.has(nameLc)) {
			// Keep the tool-list cache breakpoint on the preceding declaration.
			const previous = result.at(-1);
			if (tool.cache_control !== undefined && isPlainObject(previous) && previous.cache_control === undefined) {
				result[result.length - 1] = { ...previous, cache_control: tool.cache_control };
			}
			continue;
		}

		// Rules 2 & 3: core tools and mcp__-prefixed pass through (with dedup).
		// Skip stubs replaced at the flat entry's position, except when keeping
		// an initially active alias ahead of its later, deferred flat source.
		if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) {
			const initialAlias = initialAliasReplacements.get(nameLc);
			if (!emitted.has(nameLc) && (!replacedByFlat.has(nameLc) || initialAlias)) {
				emitted.add(nameLc);
				result.push(initialAlias ?? tool);
			}
			continue;
		}

		// Rules 4 & 5: flat tool with a known MCP alias. The alias qualifies when
		// it is advertised in this payload OR when this extension registered it
		// (covers aliases registered mid-turn, before activation catches up —
		// message_end unaliasing routes the call to the flat tool either way).
		const mcpAlias = FLAT_TO_MCP.get(nameLc);
		if (mcpAlias) {
			const aliasLc = lower(mcpAlias);
			if (initialAliasReplacements.has(aliasLc)) continue;
			if ((advertised.has(aliasLc) || registeredMcpAliases.has(aliasLc)) && !emitted.has(aliasLc)) {
				// Rename the FLAT entry: it always carries the source tool's current
				// schema, whereas an advertised alias stub can lag one turn behind a
				// mid-session source schema update. Preserve the advertised alias
				// entry's cache_control so prompt-cache breakpoints survive.
				emitted.add(aliasLc);
				const advertisedAlias = toolsByName.get(aliasLc);
				const renamed: Record<string, unknown> = { ...tool, name: mcpAlias };
				if (advertisedAlias?.cache_control !== undefined && renamed.cache_control === undefined) {
					renamed.cache_control = advertisedAlias.cache_control;
				}
				result.push(renamed);
			} else if (disableFilter && !emitted.has(nameLc)) {
				// Filter disabled: keep flat name if not yet emitted
				emitted.add(nameLc);
				result.push(tool);
			}
			continue;
		}

		// Rule 6: unknown flat-named tool
		if (disableFilter && !emitted.has(nameLc)) {
			emitted.add(nameLc);
			result.push(tool);
		}
	}

	return result;
}

export function remapToolChoice(
	toolChoice: Record<string, unknown>,
	survivingNames: Map<string, string>,
): Record<string, unknown> | undefined {
	if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string") {
		return toolChoice;
	}

	const nameLc = lower(toolChoice.name);
	const actualName = survivingNames.get(nameLc);
	if (actualName) {
		return actualName === toolChoice.name ? toolChoice : { ...toolChoice, name: actualName };
	}

	const mcpAlias = FLAT_TO_MCP.get(nameLc);
	if (mcpAlias && survivingNames.has(lower(mcpAlias))) {
		return { ...toolChoice, name: mcpAlias };
	}

	return undefined;
}

type ToolChangeBlock = Record<string, unknown> & {
	type: "tool_addition" | "tool_removal";
	tool: Record<string, unknown> &
		(
			| { type: "tool_reference"; name: string }
			| { type: "tool_definition"; definition: Record<string, unknown> & { name: string } }
		);
};

/**
 * Native mid-conversation tool changes. Pi 0.86 references tools declared in
 * the top-level list (`tool_reference`); Pi 1.x keeps that list fixed and
 * defines later tools by value (`tool_definition`, additions only), where a
 * same-name addition redefines the tool.
 */
function isToolChangeBlock(block: unknown): block is ToolChangeBlock {
	if (!isPlainObject(block) || !isPlainObject(block.tool)) return false;
	if (block.type !== "tool_addition" && block.type !== "tool_removal") return false;
	if (block.tool.type === "tool_reference") return typeof block.tool.name === "string";
	return (
		block.type === "tool_addition" &&
		block.tool.type === "tool_definition" &&
		isPlainObject(block.tool.definition) &&
		typeof block.tool.definition.name === "string"
	);
}

function isToolDefinitionAddition(block: ToolChangeBlock): boolean {
	return block.tool.type === "tool_definition";
}

function getToolChangeName(block: ToolChangeBlock): string {
	return block.tool.type === "tool_definition" ? block.tool.definition.name : block.tool.name;
}

function renameToolChange(block: ToolChangeBlock, name: string): ToolChangeBlock {
	const tool =
		block.tool.type === "tool_definition"
			? { ...block.tool, definition: { ...block.tool.definition, name } }
			: { ...block.tool, name };
	return { ...block, tool } as ToolChangeBlock;
}

/** Add the wire names of inline tool definitions, which the fixed top-level list never declares. */
function addInlineToolNames(
	messages: unknown[],
	tools: unknown[],
	survivingNames: Map<string, string>,
	hiddenAliases: ReadonlySet<string>,
): void {
	const definitions: string[] = [];
	for (const msg of messages) {
		if (!isPlainObject(msg) || msg.role !== "system" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (isToolChangeBlock(block) && isToolDefinitionAddition(block)) definitions.push(getToolChangeName(block));
		}
	}
	if (definitions.length === 0) return;
	const advertised = new Set([...collectToolNames(tools), ...definitions.map(lower)]);
	for (const name of definitions) {
		const wireName = projectDeclaredToolName(name, advertised);
		const wireLc = wireName ? lower(wireName) : "";
		if (wireName && !hiddenAliases.has(wireLc) && !survivingNames.has(wireLc)) survivingNames.set(wireLc, wireName);
	}
}

function resolveWireToolName(name: string, survivingNames: Map<string, string>): string | undefined {
	const nameLc = lower(name);
	const alias = FLAT_TO_MCP.get(nameLc);
	return survivingNames.get(nameLc) ?? (alias ? survivingNames.get(lower(alias)) : undefined);
}

/** Replay the raw tool loadout before projecting flat tools and aliases onto one wire name. */
function remapSystemToolChanges(
	content: unknown[],
	activeNames: Set<string>,
	survivingNames: Map<string, string>,
): unknown[] {
	if (!content.some(isToolChangeBlock)) return content;
	const wireNames = () =>
		new Set(
			[...activeNames].map((name) => resolveWireToolName(name, survivingNames)).filter((name) => name !== undefined),
		);
	const before = wireNames();
	const activeBefore = new Set(activeNames);
	const candidates: unknown[] = [];
	const lastChanges = new Map<string, ToolChangeBlock>();
	// Wire names redefined by value: a Pi 1.x addition of a tool that was already active.
	const redefined = new Set<string>();
	// Wire names whose kept definition came from the flat source tool.
	const flatDefinitions = new Set<string>();
	let droppedCacheControl: unknown;

	for (const block of content) {
		if (!isToolChangeBlock(block)) {
			candidates.push(block);
			continue;
		}
		const rawName = getToolChangeName(block);
		const nameLc = lower(rawName);
		if (block.type === "tool_addition") activeNames.add(nameLc);
		else activeNames.delete(nameLc);
		const name = resolveWireToolName(rawName, survivingNames);
		if (!name) {
			if (block.cache_control !== undefined) droppedCacheControl = block.cache_control;
			continue;
		}
		const key = `${block.type}:${name}`;
		const previous = lastChanges.get(key);
		let remapped = renameToolChange(block, name);
		if (isToolDefinitionAddition(block)) {
			if (activeBefore.has(nameLc)) redefined.add(name);
			// Prefer the flat source's schema, as for top-level tools: the alias stub
			// can lag one turn behind a mid-session source schema update.
			const fromFlat = lower(name) !== nameLc;
			if (previous && flatDefinitions.has(name) && !fromFlat) {
				remapped = { ...remapped, tool: previous.tool };
			} else if (fromFlat) {
				flatDefinitions.add(name);
			}
		}
		if (previous?.cache_control !== undefined && remapped.cache_control === undefined) {
			remapped.cache_control = previous.cache_control;
		}
		lastChanges.set(key, remapped);
		candidates.push(remapped);
	}

	const after = wireNames();
	const result = candidates.filter((block) => {
		if (!isToolChangeBlock(block)) return true;
		const name = getToolChangeName(block);
		// Keep only the net change. Removing the flat source must not withdraw a
		// still-active alias, and flat+alias additions must produce one addition.
		// Inline redefinitions of an already-active tool carry a new schema, so
		// they are kept while the tool stays active.
		const changed =
			block.type === "tool_addition"
				? after.has(name) && (!before.has(name) || redefined.has(name))
				: before.has(name) && !after.has(name);
		if (changed && lastChanges.get(`${block.type}:${name}`) === block) return true;
		if (block.cache_control !== undefined) droppedCacheControl = block.cache_control;
		return false;
	});
	const last = result.at(-1);
	if (
		droppedCacheControl !== undefined &&
		isPlainObject(last) &&
		(last.type === "text" || isToolChangeBlock(last)) &&
		!result.some((block) => isPlainObject(block) && block.cache_control !== undefined)
	) {
		result[result.length - 1] = { ...last, cache_control: droppedCacheControl };
	}
	return result;
}

/** Move a lost history breakpoint backward, using the same block types Pi marks. */
function restoreHistoryCacheControl(messages: unknown[], cacheControl: unknown): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!isPlainObject(msg) || (msg.role !== "user" && msg.role !== "system")) continue;
		if (typeof msg.content === "string" && msg.content.trim().length > 0) {
			messages[i] = { ...msg, content: [{ type: "text", text: msg.content, cache_control: cacheControl }] };
			return;
		}
		if (!Array.isArray(msg.content)) continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const block = msg.content[j];
			if (
				!isPlainObject(block) ||
				!(block.type === "text" || block.type === "image" || block.type === "tool_result" || isToolChangeBlock(block))
			) {
				continue;
			}
			// An existing breakpoint already covers this prefix; retain its TTL.
			if (block.cache_control === undefined) {
				const content = [...msg.content];
				content[j] = { ...block, cache_control: cacheControl };
				messages[i] = { ...msg, content };
			}
			return;
		}
	}
}

export function remapMessageToolNames(
	messages: unknown[],
	survivingNames: Map<string, string>,
	tools: unknown[] = [],
): unknown[] {
	// Non-deferred declarations are active initially; later declarations become
	// available through the transcript's tool_addition blocks.
	const activeNames = collectToolNames(tools.filter((tool) => isPlainObject(tool) && tool.defer_loading !== true));
	let anyChanged = false;
	const result: unknown[] = [];
	for (const msg of messages) {
		if (!isPlainObject(msg) || !Array.isArray(msg.content)) {
			result.push(msg);
			continue;
		}
		const content =
			msg.role === "system"
				? remapSystemToolChanges(msg.content, activeNames, survivingNames)
				: remapBlockNames(msg.content, "tool_use", (n) => {
						const alias = FLAT_TO_MCP.get(lower(n));
						if (!alias) return undefined;
						const aliasLc = lower(alias);
						// With an unchanged mapping, registered aliases stay stable in history
						// even when the current request omits their tool definitions.
						return registeredMcpAliases.has(aliasLc) || survivingNames.has(aliasLc) ? alias : undefined;
					});
		if (content === msg.content) {
			result.push(msg);
			continue;
		}
		anyChanged = true;
		// A filtered update may have no blocks left. Keep effort/configuration
		// messages, whose fields outside content still carry meaning.
		if (content.length > 0 || Object.keys(msg).some((key) => key !== "role" && key !== "content")) {
			result.push({ ...msg, content });
		}
		if (msg.role === "system" && !content.some((block) => isPlainObject(block) && block.cache_control !== undefined)) {
			// The within-message transfer cannot preserve a marker when every change
			// disappears. Restore it on surviving content at or before this position.
			for (let i = msg.content.length - 1; i >= 0; i--) {
				const block = msg.content[i];
				if (isToolChangeBlock(block) && block.cache_control !== undefined) {
					restoreHistoryCacheControl(result, block.cache_control);
					break;
				}
			}
		}
	}
	return anyChanged ? result : messages;
}

/**
 * Filter and alias the tools of an Anthropic OAuth request in place: the
 * top-level list, Pi 1.x inline tool definitions, native tool changes,
 * tool_choice, and historical tool_use names.
 */
export function transformToolPayload(payload: Record<string, unknown>, activeToolNames: readonly string[] = []): void {
	const originalTools = Array.isArray(payload.tools) ? payload.tools : [];
	const hiddenAliases = findHiddenSourceAliases(payload, activeToolNames);
	payload.tools = filterAndRemapTools(payload.tools as unknown[] | undefined, false, hiddenAliases);

	// Tool names that survived filtering (lowercase → wire name).
	const survivingNames = new Map<string, string>();
	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			if (isPlainObject(tool) && typeof tool.name === "string") {
				survivingNames.set(lower(tool.name), tool.name);
			}
		}
	}

	// Pi 1.x keeps the top-level list fixed and defines later tools inline.
	if (Array.isArray(payload.messages)) {
		addInlineToolNames(payload.messages, originalTools, survivingNames, hiddenAliases);
	}

	if (isPlainObject(payload.tool_choice)) {
		const remapped = remapToolChoice(payload.tool_choice, survivingNames);
		if (remapped === undefined) {
			delete payload.tool_choice;
		} else {
			payload.tool_choice = remapped;
		}
	}

	// Rewrite historical calls and native mid-conversation tool changes.
	if (Array.isArray(payload.messages)) {
		payload.messages = remapMessageToolNames(payload.messages, survivingNames, originalTools);
	}
}
