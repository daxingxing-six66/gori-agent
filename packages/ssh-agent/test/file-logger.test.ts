import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatCompactionError } from "../src/domain/context-compaction.ts";
import { createFileConsole } from "../src/server/file-logger.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("file logger", () => {
	it("rolls by local day and size and resumes existing segments after restart", () => {
		const directory = mkdtempSync(join(tmpdir(), "ssh-agent-logs-"));
		directories.push(directory);
		let now = new Date(2026, 8, 10, 12);
		const options = { directory, maxBytes: 100, clock: () => now };
		const logger = createFileConsole(options);
		logger.info("x".repeat(60));
		logger.info("y".repeat(60));
		createFileConsole(options).info("z".repeat(60));
		now = new Date(2026, 8, 11, 0);
		logger.info("new day");
		expect(readdirSync(directory).sort()).toEqual([
			"ssh-agent-2026-09-10.0.log",
			"ssh-agent-2026-09-10.1.log",
			"ssh-agent-2026-09-10.2.log",
			"ssh-agent-2026-09-11.0.log",
		]);
		expect(statSync(join(directory, "ssh-agent-2026-09-10.0.log")).mode & 0o777).toBe(0o600);
	});
	it("preserves wrapper and original exception stacks without JSON Error loss", () => {
		const directory = mkdtempSync(join(tmpdir(), "ssh-agent-logs-"));
		directories.push(directory);
		const cause = new Error("provider original failure");
		const error = new ChatCompactionError("chat_context_compaction_failed", "Summary failed", { cause });
		createFileConsole({ directory }).error("compaction.failed", error);
		const content = readFileSync(join(directory, readdirSync(directory)[0]!), "utf8");
		expect(content).toContain("ERROR");
		expect(content).toContain("ChatCompactionError: Summary failed");
		expect(content).toContain("Error: provider original failure");
		expect(content).toContain("file-logger.test.ts:");
		expect(error.cause).toBe(cause);
	});
	it("falls back to stderr output when storage fails without throwing into the application", () => {
		const directory = mkdtempSync(join(tmpdir(), "ssh-agent-logs-"));
		directories.push(directory);
		const fallback = vi.fn();
		const logger = createFileConsole({ directory, fallback });
		rmSync(directory, { recursive: true });
		expect(() => logger.error("original failure")).not.toThrow();
		expect(fallback).toHaveBeenCalledWith(expect.stringContaining("original failure"));
	});
});
