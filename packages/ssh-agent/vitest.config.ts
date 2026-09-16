import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const repositoryRoot = resolve(import.meta.dirname, "../..");

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-agent-core\/node$/,
				replacement: resolve(repositoryRoot, "packages/agent/src/node.ts"),
			},
			{
				find: /^@earendil-works\/pi-agent-core$/,
				replacement: resolve(repositoryRoot, "packages/agent/src/index.ts"),
			},
			{
				find: /^@earendil-works\/pi-ai\/providers\/all$/,
				replacement: resolve(repositoryRoot, "packages/ai/src/providers/all.ts"),
			},
			{
				find: /^@earendil-works\/pi-ai$/,
				replacement: resolve(repositoryRoot, "packages/ai/src/index.ts"),
			},
			{
				find: /^@earendil-works\/pi-telemetry$/,
				replacement: resolve(repositoryRoot, "packages/telemetry/src/index.ts"),
			},
		],
	},
});
