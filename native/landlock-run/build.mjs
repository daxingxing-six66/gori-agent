import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./", import.meta.url));
const resources = fileURLToPath(new URL("../../packages/ssh-agent/resources/sandbox/", import.meta.url));
const compiler = process.env.GORI_ZIG ?? "zig";
const version = spawnSync(compiler, ["version"], { encoding: "utf8" });
if (version.status !== 0 || version.stdout.trim() !== "0.15.2") throw new Error("Build requires Zig 0.15.2 (set GORI_ZIG to its executable).");
const digest = (data) => createHash("sha256").update(data).digest("hex");
const binaries = {};
for (const [architecture, target] of [["x64", "x86_64-linux-musl"], ["arm64", "aarch64-linux-musl"]]) {
	const outputDirectory = join(resources, `linux-${architecture}`);
	mkdirSync(outputDirectory, { recursive: true });
	const output = join(outputDirectory, "gori-landlock-run");
	const result = spawnSync(compiler, ["cc", "-target", target, "-std=c11", "-static", "-Os", "-s", "-Wall", "-Wextra", "-Werror", "-fstack-protector-strong", join(directory, "main.c"), "-o", output], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	binaries[`linux-${architecture}`] = digest(readFileSync(output));
}
writeFileSync(join(resources, "manifest.json"), JSON.stringify({ launcherVersion: "1", minimumAbi: 5, compiler: "zig 0.15.2", sourceSha256: digest(readFileSync(join(directory, "main.c"))), binaries }, null, 2) + "\n");
