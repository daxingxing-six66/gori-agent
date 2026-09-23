#!/usr/bin/env node

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { readSshAgentServerEnvironment } from "./environment.ts";
import { createFileConsole } from "./file-logger.ts";
import { createSshAgentServer } from "./ssh-agent-server.ts";

process.umask(0o077);

try {
	const options = readSshAgentServerEnvironment();
	globalThis.console = createFileConsole({ directory: options.logDirectory });
	process.stdout.write(`Gori data: ${options.dataDirectory}\nSSH Agent logs: ${options.logDirectory}\n`);
	process.on("uncaughtExceptionMonitor", (error) => console.error("Uncaught exception", error));
	const server = createSshAgentServer({
		...options,
		llmModelsFactory: (credentials) => builtinModels({ credentials }),
	});
	const address = await server.listen();
	console.info(`SSH Agent HTTP server listening on ${address.origin}`);

	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.info(`SSH Agent HTTP server received ${signal}; shutting down`);
		try {
			await server.close();
		} catch (error) {
			console.error("SSH Agent HTTP server shutdown failed", error);
			process.exitCode = 1;
		}
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
} catch (error) {
	console.error("SSH Agent HTTP server failed to start", error);
	process.exitCode = 1;
}
