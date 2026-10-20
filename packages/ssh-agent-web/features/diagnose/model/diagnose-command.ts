export function diagnoseCommand(message: string): { problem: string } | null {
	const match = message.trim().match(/^\/diagnose(?:\s+([\s\S]*))?$/iu);
	return match ? { problem: match[1]?.trim() ?? "" } : null;
}
