export type SessionSandboxCommand = { kind: "toggle" } | { kind: "status" } | { kind: "set"; enabled: boolean } | { kind: "invalid" };

export function parseSessionSandboxCommand(message: string): SessionSandboxCommand | null {
	const match = message.trim().match(/^\/sandbox(?:\s+(.*))?$/u);
	if (!match) return null;
	switch (match[1]?.trim()) {
		case undefined: return { kind: "toggle" };
		case "status": return { kind: "status" };
		case "on": return { kind: "set", enabled: true };
		case "off": return { kind: "set", enabled: false };
		default: return { kind: "invalid" };
	}
}

export function isSessionSandboxCommand(message: string): boolean {
	return parseSessionSandboxCommand(message) !== null;
}
