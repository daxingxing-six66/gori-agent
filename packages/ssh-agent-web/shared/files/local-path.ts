/** Lexical identity only; the server always validates the actual filesystem path. */
export function localPathIdentity(path: string, workDir?: string | null): string {
	const windows = /^[a-z]:[\\/]/i.test(workDir ?? path) || path.startsWith("\\\\");
	const input = windows ? path.replaceAll("\\", "/") : path;
	const absolute = input.startsWith("/") || /^[a-z]:\//i.test(input);
	const base = windows ? workDir?.replaceAll("\\", "/") : workDir;
	const joined = !absolute && base ? `${base}/${input}` : input;
	const prefix = joined.startsWith("//") ? "//" : joined.startsWith("/") ? "/" : "";
	const parts: string[] = [];
	for (const part of joined.split("/")) {
		if (!part || part === ".") continue;
		if (part === ".." && parts.length && parts.at(-1) !== ".." && !parts.at(-1)?.endsWith(":")) parts.pop();
		else if (part !== ".." || !prefix) parts.push(part);
	}
	return prefix + parts.join("/");
}
