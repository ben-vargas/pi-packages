import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEPRECATION_MESSAGE =
	"[pi-antigravity-image-gen] Deprecated and disabled: Google has started banning accounts that use third-party Antigravity harnesses. This package no longer registers image-generation tools.";

export default function antigravityImageGen(_pi: ExtensionAPI) {
	console.warn(DEPRECATION_MESSAGE);
}

export { DEPRECATION_MESSAGE };
