import type { RemoteSandboxProvider } from "../src/application/services/remote-sandbox-provider.ts";

export const terminalTestSandbox: RemoteSandboxProvider = {
	prepare: async () => { throw new Error("Unexpected remote command preparation"); },
	prepareTerminal: async () => ({
		command: "test-launcher --terminal",
		confirmation: "gori-landlock: confined abi=8 token=test",
		sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 8, launcherVersion: "2", sandboxRoot: "/srv/test" },
	}),
};
