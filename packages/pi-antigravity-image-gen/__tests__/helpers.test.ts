import { describe, expect, it } from "vitest";
import { buildRequest, parseOAuthCredentials, resolveSaveConfig } from "../extensions/index.js";

describe("pi-antigravity-image-gen helpers", () => {
	it("parses OAuth credentials", () => {
		const creds = parseOAuthCredentials(JSON.stringify({ token: "t", projectId: "p" }));
		expect(creds).toEqual({ accessToken: "t", projectId: "p" });
		expect(() => parseOAuthCredentials("not-json")).toThrow(/Invalid Google OAuth credentials/);
		expect(() => parseOAuthCredentials(JSON.stringify({ token: "t" }))).toThrow(/Missing token or projectId/);
	});

	it("resolves save config from params and env", () => {
		const previousMode = process.env.PI_IMAGE_SAVE_MODE;
		const previousDir = process.env.PI_IMAGE_SAVE_DIR;
		process.env.PI_IMAGE_SAVE_MODE = "custom";
		process.env.PI_IMAGE_SAVE_DIR = "/tmp/images";

		const custom = resolveSaveConfig({ prompt: "hi" } as never, "/tmp/project");
		expect(custom).toEqual({ mode: "custom", outputDir: "/tmp/images" });

		process.env.PI_IMAGE_SAVE_MODE = "project";
		process.env.PI_IMAGE_SAVE_DIR = "";
		const project = resolveSaveConfig({ prompt: "hi" } as never, "/tmp/project");
		expect(project).toEqual({ mode: "project", outputDir: "/tmp/project/.pi/generated-images" });

		if (previousMode === undefined) {
			delete process.env.PI_IMAGE_SAVE_MODE;
		} else {
			process.env.PI_IMAGE_SAVE_MODE = previousMode;
		}
		if (previousDir === undefined) {
			delete process.env.PI_IMAGE_SAVE_DIR;
		} else {
			process.env.PI_IMAGE_SAVE_DIR = previousDir;
		}
	});

	it("builds request payload", () => {
		const originalNow = Date.now;
		const originalRandom = Math.random;
		Date.now = () => 123456;
		Math.random = () => 0.123456789;

		const request = buildRequest("hello", "project-1", "16:9");
		expect(request.project).toBe("project-1");
		expect(request.request.contents[0]?.parts[0]?.text).toBe("hello");
		expect(request.request?.generationConfig?.imageConfig?.aspectRatio).toBe("16:9");
		expect((request.requestId ?? "").startsWith("agent-123456-")).toBe(true);
		expect(typeof request.model).toBe("string");

		Date.now = originalNow;
		Math.random = originalRandom;
	});
});
