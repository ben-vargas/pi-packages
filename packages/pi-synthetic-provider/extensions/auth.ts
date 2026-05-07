/**
 * API key resolution logic for the Synthetic provider.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Check if Synthetic API key is available from any source.
 * Priority: auth.json > environment variable
 */
export async function getSyntheticApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	// Check environment variable first (as fallback)
	const envKey = process.env.SYNTHETIC_API_KEY;

	// Try to get from modelRegistry (which checks auth.json)
	try {
		const authKey = await ctx.modelRegistry.getApiKeyForProvider("synthetic");
		if (authKey) return authKey;
	} catch {
		// Provider not registered yet, ignore
	}

	return envKey;
}

/**
 * Check if API key is configured (without retrieving it)
 * Uses getApiKeyForProvider which checks auth.json, env vars, etc.
 */
export async function hasSyntheticApiKey(ctx: ExtensionContext): Promise<boolean> {
	// Check environment variable first (fast path)
	if (process.env.SYNTHETIC_API_KEY) return true;

	// Check via modelRegistry (checks auth.json, env vars, and other sources)
	try {
		const authKey = await ctx.modelRegistry.getApiKeyForProvider("synthetic");
		return !!authKey;
	} catch {
		// Provider not registered yet or other error
		return false;
	}
}
