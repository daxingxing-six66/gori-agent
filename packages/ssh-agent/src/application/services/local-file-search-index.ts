import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import ignore, { type Ignore } from "ignore";
import { ManagementError } from "../../domain/errors.ts";
import { LocalFileSystemError, type LocalFileSearchOptions, type LocalFileSearchResult } from "../../domain/local-file-system.ts";
import { fileSearchScore, normalizeFileQuery, prepareSearchCandidate, type SearchCandidate } from "./local-file-search-ranking.ts";

const DEFAULT_IGNORES = ["node_modules/", ".cache/", ".next/", ".turbo/", ".gradle/", "target/", "dist/", "coverage/"];
const VCS_DIRECTORIES = new Set([".git", ".hg", ".svn"]);
interface Index { candidates: SearchCandidate[]; incomplete: boolean }
interface CachedIndex {
	promise: Promise<Index>;
	controller: AbortController;
	consumers: number;
	ready: boolean;
	expiresAt: number;
	abortTimer?: ReturnType<typeof setTimeout>;
}
interface IgnoreLayer { directory: string; rules: Ignore }

export interface LocalFileSearchIndexOptions {
	maxEntries?: number;
	maxDirectories?: number;
	maxDurationMs?: number;
	maxPathCharacters?: number;
	maxCachedRoots?: number;
	cacheTtlMs?: number;
	maxResults?: number;
	now?: () => number;
}

/** Service-owned bounded name indexes. No file contents, subprocesses, persistent database or per-keystroke walk. */
export class LocalFileSearchIndex {
	readonly #cache = new Map<string, CachedIndex>();
	readonly #options: Required<LocalFileSearchIndexOptions>;
	#activeBuilds = 0;
	readonly #buildWaiters = new Set<() => void>();

	constructor(options: LocalFileSearchIndexOptions = {}) {
		this.#options = { maxEntries: 100_000, maxDirectories: 25_000, maxDurationMs: 5000,
			maxPathCharacters: 8_000_000, maxCachedRoots: 4, cacheTtlMs: 10_000, maxResults: 80, now: () => performance.now(), ...options };
	}

	async search(rootPath: string, rawQuery: string, options: LocalFileSearchOptions = {}): Promise<LocalFileSearchResult> {
		options.signal?.throwIfAborted();
		if (rawQuery.length > 512 || rawQuery.includes("\0")) throw new ManagementError("validation_error", "query must be at most 512 characters without NUL", "query");
		if (!rawQuery.trim()) return { entries: [], truncated: false, incomplete: false };
		const { scope, query } = await searchScope(rootPath, rawQuery.trim());
		options.signal?.throwIfAborted();
		const key = `${scope}\0${options.includeIgnored === true}`;
		let cached = this.#cache.get(key);
		if (cached?.ready && (options.refresh || cached.expiresAt <= this.#options.now())) {
			this.#cache.delete(key);
			cached = undefined;
		}
		if (!cached) cached = this.#createIndex(key, scope, options.includeIgnored === true);
		// Map insertion order is the LRU order. Pending builds are shared across queries/Sessions using the same scope.
		this.#cache.delete(key);
		this.#cache.set(key, cached);
		clearTimeout(cached.abortTimer);
		cached.consumers++;
		let index: Index;
		try {
			index = await abortable(cached.promise, options.signal);
		} finally {
			cached.consumers--;
			if (!cached.ready && cached.consumers === 0) {
				const abandoned = cached;
				// Allow the next debounced query to reuse a cold build rather than restarting it on every keypress.
				cached.abortTimer = setTimeout(() => {
					if (this.#cache.get(key) === abandoned) this.#cache.delete(key);
					abandoned.controller.abort();
				}, 500);
				cached.abortTimer.unref();
			}
		}
		const best: { candidate: SearchCandidate; score: number }[] = [];
		let matchCount = 0;
		for (let offset = 0; offset < index.candidates.length; offset++) {
			if (offset % 256 === 0) { await yieldToIo(); options.signal?.throwIfAborted(); }
			const candidate = index.candidates[offset]!;
			const score = fileSearchScore(candidate, query);
			if (score === undefined) continue;
			matchCount++;
			const item = { candidate, score };
			let low = 0, high = best.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (compareMatches(item, best[middle]!) < 0) high = middle;
				else low = middle + 1;
			}
			if (low < this.#options.maxResults * 2) best.splice(low, 0, item);
			if (best.length > this.#options.maxResults * 2) best.pop();
		}
		const entries: LocalFileSearchResult["entries"] = [];
		for (const { candidate } of best) {
			options.signal?.throwIfAborted();
			const path = resolve(scope, candidate.relativePath);
			try {
				// Recheck cached candidates: deletes, type changes and new symlink ancestors must not leak stale/outside paths.
				if (await realpath(path) !== path) continue;
				const stat = await lstat(path);
				const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined;
				if (!type) continue;
				entries.push({ name: candidate.name, path, relativePath: relative(rootPath, path), type, size: stat.size, modifiedAt: stat.mtimeMs });
				if (entries.length === this.#options.maxResults) break;
			} catch { /* A concurrently removed or unreadable candidate is omitted. */ }
		}
		return { entries, truncated: matchCount > entries.length, incomplete: index.incomplete };
	}

	#createIndex(key: string, scope: string, includeIgnored: boolean): CachedIndex {
		for (const [oldKey, entry] of this.#cache) {
			if (entry.ready && entry.expiresAt <= this.#options.now()) this.#cache.delete(oldKey);
		}
		if (this.#cache.size >= this.#options.maxCachedRoots) {
			const victim = [...this.#cache].find(([, entry]) => entry.ready || entry.consumers === 0);
			if (!victim) throw new LocalFileSystemError("local_file_system_unavailable", "Too many active local file searches", 503);
			clearTimeout(victim[1].abortTimer);
			victim[1].controller.abort();
			this.#cache.delete(victim[0]);
		}
		const controller = new AbortController();
		const promise = Promise.resolve().then(async () => {
			while (this.#activeBuilds >= 2) {
				let wake!: () => void;
				try { await abortable(new Promise<void>((resolveWait) => { wake = resolveWait; this.#buildWaiters.add(wake); }), controller.signal); }
				finally { this.#buildWaiters.delete(wake); }
			}
			controller.signal.throwIfAborted();
			this.#activeBuilds++;
			try {
				const index = await this.#build(scope, includeIgnored, controller.signal);
				entry.ready = true;
				entry.expiresAt = this.#options.now() + this.#options.cacheTtlMs;
				return index;
			} finally {
				this.#activeBuilds--;
				for (const wake of this.#buildWaiters) wake();
			}
		}).catch((error: unknown) => {
			if (this.#cache.get(key) === entry) this.#cache.delete(key);
			throw error;
		}).finally(() => clearTimeout(entry.abortTimer));
		const entry: CachedIndex = { promise, controller, consumers: 0, ready: false, expiresAt: 0 };
		this.#cache.set(key, entry);
		return entry;
	}

	async #build(root: string, includeIgnored: boolean, signal: AbortSignal): Promise<Index> {
		const candidates: SearchCandidate[] = [];
		const directories: { path: string; layers: IgnoreLayer[] }[] = [{ path: root, layers: includeIgnored ? [] : [{ directory: root, rules: ignore().add(DEFAULT_IGNORES) }] }];
		let incomplete = false, characters = 0, inspected = 0;
		const started = performance.now();
		for (let position = 0; position < directories.length; position++) {
			signal.throwIfAborted();
			if (position >= this.#options.maxDirectories || performance.now() - started >= this.#options.maxDurationMs) { incomplete = true; break; }
			const directory = directories[position]!;
			try {
				if (await realpath(directory.path) !== directory.path) { incomplete = true; continue; }
				const layers = [...directory.layers];
				if (!includeIgnored) {
					for (const name of [".gitignore", ".ignore"]) {
						const text = await readIgnoreFile(resolve(directory.path, name));
						if (text === null) incomplete = true;
						else if (text !== undefined) layers.push({ directory: directory.path, rules: ignore().add(text) });
					}
				}
				const handle = await opendir(directory.path, { bufferSize: 64 });
				for await (const child of handle) {
					if (inspected++ % 256 === 0) { await yieldToIo(); signal.throwIfAborted(); }
					if (inspected > this.#options.maxEntries || performance.now() - started >= this.#options.maxDurationMs) return { candidates, incomplete: true };
					const type = child.isDirectory() ? "directory" : child.isFile() ? "file" : undefined;
					if (!type || (type === "directory" && VCS_DIRECTORIES.has(child.name))) continue;
					const path = resolve(directory.path, child.name);
					const relativePath = relative(root, path).split(sep).join("/");
					let ignored = false;
					for (const layer of layers) {
						const verdict = layer.rules.test(relative(layer.directory, path).split(sep).join("/") + (type === "directory" ? "/" : ""));
						if (verdict.ignored) ignored = true;
						else if (verdict.unignored) ignored = false;
					}
					if (ignored) continue;
					characters += relativePath.length;
					if (characters > this.#options.maxPathCharacters) return { candidates, incomplete: true };
					candidates.push(prepareSearchCandidate(relativePath, type));
					if (type === "directory") {
						if (directories.length < this.#options.maxDirectories) directories.push({ path, layers });
						else incomplete = true;
					}
				}
			} catch (error) {
				signal.throwIfAborted();
				if (position === 0) throw new LocalFileSystemError("local_file_access_denied", "Unable to index local directory", 403, error instanceof Error ? error : undefined);
				incomplete = true;
			}
		}
		return { candidates, incomplete };
	}
}

function compareMatches(left: { candidate: SearchCandidate; score: number }, right: { candidate: SearchCandidate; score: number }): number {
	return left.score - right.score || left.candidate.lowerName.length - right.candidate.lowerName.length
		|| left.candidate.relativePath.length - right.candidate.relativePath.length
		|| (left.candidate.relativePath < right.candidate.relativePath ? -1 : left.candidate.relativePath > right.candidate.relativePath ? 1 : 0);
}

async function readIgnoreFile(path: string): Promise<string | null | undefined> {
	try {
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > 65_536 || await realpath(path) !== path) return null;
			const buffer = Buffer.alloc(65_537);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return bytesRead <= 65_536 ? buffer.subarray(0, bytesRead).toString("utf8") : null;
		} finally { await handle.close(); }
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		return null;
	}
}

async function searchScope(root: string, rawQuery: string): Promise<{ scope: string; query: string }> {
	const query = rawQuery.replaceAll("\\", "/");
	const slash = query.lastIndexOf("/");
	if (slash < 0) return { scope: root, query: normalizeFileQuery(query) };
	const directory = resolve(root, query.slice(0, slash + 1));
	const rel = relative(root, directory);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new LocalFileSystemError("local_file_path_outside_work_dir", "Search scope is outside the Session directory", 403);
	try {
		const canonical = await realpath(directory);
		if (canonical !== directory) {
			// Case-insensitive volumes may return the on-disk spelling. Check the path
			// components rather than treating every spelling difference as a symlink.
			let component = root;
			for (const name of rel.split(sep).filter(Boolean)) {
				component = resolve(component, name);
				if ((await lstat(component)).isSymbolicLink()) throw new LocalFileSystemError("local_file_path_symlink_not_allowed", "Search scope contains symbolic links", 403);
			}
			const canonicalRelative = relative(root, canonical);
			if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) throw new LocalFileSystemError("local_file_path_outside_work_dir", "Search scope is outside the Session directory", 403);
		}
		if ((await lstat(canonical)).isDirectory()) return { scope: canonical, query: normalizeFileQuery(query.slice(slash + 1)) };
	} catch (error) {
		if (error instanceof LocalFileSystemError) throw error;
	}
	return { scope: root, query: normalizeFileQuery(query) };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolveValue, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolveValue, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
	});
}
