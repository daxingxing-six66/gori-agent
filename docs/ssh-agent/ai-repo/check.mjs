import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const aiRepoDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(aiRepoDirectory, "../../..");
const manifestPath = resolve(aiRepoDirectory, "manifest.json");
const update = process.argv[2] === "--update";

if (process.argv.length > (update ? 3 : 2)) {
	throw new Error("Usage: node docs/ssh-agent/ai-repo/check.mjs [--update]");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.documents) || typeof manifest.index !== "string") {
	throw new Error("Invalid Gori AI repository manifest");
}

const errors = [];
const indexPath = repositoryPath(manifest.index);
const indexContent = await readFile(indexPath, "utf8");
const documentPaths = new Set();
const markdownFiles = (await listMarkdownFiles(aiRepoDirectory))
	.map((path) => relative(repositoryRoot, path))
	.filter((path) => path !== manifest.index)
	.sort();

await validateLocalLinks(manifest.index, indexContent);

for (const entry of manifest.documents) {
	if (
		typeof entry.document !== "string" ||
		!Array.isArray(entry.sources) ||
		entry.sources.some((source) => typeof source !== "string")
	) {
		errors.push("Manifest contains an invalid document entry");
		continue;
	}
	if (documentPaths.has(entry.document)) errors.push(`Duplicate document mapping: ${entry.document}`);
	documentPaths.add(entry.document);
	const documentPath = repositoryPath(entry.document);
	if (!(await isFile(documentPath))) errors.push(`Feature document does not exist: ${entry.document}`);
	else await validateLocalLinks(entry.document, await readFile(documentPath, "utf8"));
	const route = `./${relative(dirname(indexPath), documentPath)}`;
	if (!indexContent.includes(`](${route})`)) errors.push(`Index does not route to: ${entry.document}`);
	if (entry.sources.length === 0) errors.push(`Document has no mapped sources: ${entry.document}`);
	if (new Set(entry.sources).size !== entry.sources.length) errors.push(`Document has duplicate sources: ${entry.document}`);

	const missingSources = [];
	for (const source of entry.sources) {
		if (!(await isFile(repositoryPath(source)))) missingSources.push(source);
	}
	if (missingSources.length > 0) {
		for (const source of missingSources) errors.push(`Mapped source does not exist: ${source}`);
		continue;
	}

	if (update) {
		entry.sourceDigests = Object.fromEntries(
			await Promise.all(entry.sources.map(async (source) => [source, await sourceDigest(source)])),
		);
		delete entry.sourceDigest;
	} else if (entry.sourceDigests === null || typeof entry.sourceDigests !== "object") {
		errors.push(`Document has no source digests: ${entry.document}`);
	} else {
		for (const source of entry.sources) {
			const digest = await sourceDigest(source);
			if (entry.sourceDigests[source] !== digest) {
				errors.push(`Mapped source changed for ${entry.document}: ${source}`);
			}
		}
		for (const source of Object.keys(entry.sourceDigests)) {
			if (!entry.sources.includes(source)) errors.push(`Document has an obsolete source digest: ${source}`);
		}
	}
}

for (const markdownFile of markdownFiles) {
	if (!documentPaths.has(markdownFile)) errors.push(`Feature document is not mapped: ${markdownFile}`);
}

if (errors.length > 0) {
	for (const error of errors) process.stderr.write(`${error}\n`);
	process.stderr.write("Read the affected source and document before refreshing digests with --update.\n");
	process.exitCode = 1;
} else if (update) {
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	process.stdout.write(`Updated ${manifest.documents.length} Gori AI repository source digests.\n`);
} else {
	process.stdout.write(`Gori AI repository is consistent (${manifest.documents.length} documents).\n`);
}

function repositoryPath(path) {
	if (isAbsolute(path)) throw new Error(`Manifest path must be repository-relative: ${path}`);
	const absolutePath = resolve(repositoryRoot, path);
	const relativePath = relative(repositoryRoot, absolutePath);
	if (relativePath === ".." || relativePath.startsWith("../")) {
		throw new Error(`Manifest path escapes the repository: ${path}`);
	}
	return absolutePath;
}

async function isFile(path) {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function validateLocalLinks(document, content) {
	const documentDirectory = dirname(repositoryPath(document));
	for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
		const target = match[1].trim();
		if (target.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
		const pathWithoutFragment = target.split("#", 1)[0];
		if (pathWithoutFragment.length === 0) continue;
		const absoluteTarget = resolve(documentDirectory, decodeURIComponent(pathWithoutFragment));
		const relativeTarget = relative(repositoryRoot, absoluteTarget);
		if (relativeTarget === ".." || relativeTarget.startsWith("../")) {
			errors.push(`Local link escapes the repository in ${document}: ${target}`);
		} else if (!(await exists(absoluteTarget))) {
			errors.push(`Broken local link in ${document}: ${target}`);
		}
	}
}

async function sourceDigest(source) {
	const hash = createHash("sha256");
	hash.update(await readFile(repositoryPath(source)));
	return `sha256:${hash.digest("hex")}`;
}

async function listMarkdownFiles(directory) {
	const paths = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) paths.push(...(await listMarkdownFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
	}
	return paths;
}
