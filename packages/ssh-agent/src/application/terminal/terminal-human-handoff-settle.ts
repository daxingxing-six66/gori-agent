import type { TerminalSequencedEvent } from "./terminal-replay-ring.ts";

const ECHO_QUIET_MS = 150;
const MAXIMUM_WAIT_MS = 1000;

/** Let final keyboard echo arrive without waiting for the foreground program to finish. */
export async function settleHumanActivity(source: {
	subscribe(listener: (event: TerminalSequencedEvent) => void): () => void;
}): Promise<void> {
	let quiet: ReturnType<typeof setTimeout> | undefined;
	let maximum: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		await new Promise<void>((resolve) => {
			unsubscribe = source.subscribe((event) => {
				if (event.type === "terminal.output") {
					if (quiet !== undefined) clearTimeout(quiet);
					quiet = setTimeout(resolve, ECHO_QUIET_MS);
				}
				if (event.type === "terminal.status") resolve();
			});
			quiet = setTimeout(resolve, ECHO_QUIET_MS);
			maximum = setTimeout(resolve, MAXIMUM_WAIT_MS);
		});
	} finally {
		if (quiet !== undefined) clearTimeout(quiet);
		if (maximum !== undefined) clearTimeout(maximum);
		unsubscribe?.();
	}
}
