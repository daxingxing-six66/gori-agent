import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isContextOverflow, normalizeContextOverflowError } from "../src/utils/overflow.ts";

describe("provider scoped empty-response overflow", () => {
	it.each(["400 status code (no body)", "413 status code (no body)"])("restricts %s to Cerebras", (errorMessage) => {
		for (const provider of ["cerebras", "opencode-go", "openai", "custom-provider"]) {
			const message = { ...fauxAssistantMessage("", { stopReason: "error", errorMessage }), provider };
			expect(isContextOverflow(message)).toBe(provider === "cerebras");
			expect(normalizeContextOverflowError(message).errorCode).toBe(
				provider === "cerebras" ? "context_overflow" : undefined,
			);
		}
	});
});
