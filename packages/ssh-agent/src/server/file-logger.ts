import { Console } from "node:console";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export const DEFAULT_LOG_DIRECTORY = fileURLToPath(new URL("../../logs/", import.meta.url));

/** Single-process local logging. Each record is written before returning. */
export function createFileConsole(
	options: { directory?: string; maxBytes?: number; clock?: () => Date; fallback?: (message: string) => void } = {},
): Console {
	const directory = options.directory ?? DEFAULT_LOG_DIRECTORY;
	const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Log maxBytes must be a positive integer");
	const clock = options.clock ?? (() => new Date());
	const fallback = options.fallback ?? ((message: string) => process.stderr.write(message));
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let currentDay = "";
	let part = 0;
	const stream = (level: string) =>
		new Writable({
			write(chunk: Buffer, _encoding, callback) {
				const now = clock();
				const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
				const record = `${now.toISOString()} ${level} ${chunk.toString("utf8")}`;
				try {
					if (day !== currentDay) {
						currentDay = day;
						part = 0;
					}
					for (;;) {
						const path = join(directory, `ssh-agent-${day}.${part}.log`);
						let size = 0;
						try {
							size = statSync(path).size;
						} catch (error) {
							if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
						}
						// Oversized records remain intact in their own segment.
						if (size > 0 && size + Buffer.byteLength(record) > maxBytes) {
							part++;
							continue;
						}
						appendFileSync(path, record, { mode: 0o600 });
						break;
					}
				} catch (error) {
					fallback(
						`SSH Agent log write failed: ${error instanceof Error ? error.stack : String(error)}\n${record}`,
					);
				}
				callback();
			},
		});
	return new Console({
		stdout: stream("INFO"),
		stderr: stream("ERROR"),
		colorMode: false,
		inspectOptions: {
			depth: null,
			maxStringLength: null,
			maxArrayLength: null,
			customInspect: false,
			getters: false,
		},
	});
}
