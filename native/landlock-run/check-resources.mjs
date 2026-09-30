import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const resources = new URL("../../packages/ssh-agent/resources/sandbox/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", resources), "utf8"));
const digest = (data) => createHash("sha256").update(data).digest("hex");
if (manifest.launcherVersion !== "1" || manifest.minimumAbi !== 5 || manifest.compiler !== "zig 0.15.2") throw new Error("Sandbox manifest has incompatible policy/build metadata");
if (digest(readFileSync(new URL("main.c", import.meta.url))) !== manifest.sourceSha256) throw new Error("Rebuild the sandbox launchers after editing main.c");
const policy = readFileSync(new URL("../../packages/ssh-agent/src/domain/remote-sandbox.ts", import.meta.url), "utf8");
const source = readFileSync(new URL("main.c", import.meta.url), "utf8");
if (!policy.includes(`GORI_MIN_LANDLOCK_ABI = ${manifest.minimumAbi};`) || !policy.includes(`GORI_LANDLOCK_LAUNCHER_VERSION = "${manifest.launcherVersion}";`) || !source.includes(`#define MIN_ABI ${manifest.minimumAbi}\n`)) throw new Error("Native and application sandbox policy versions disagree");
for (const [architecture, machine] of [["x64", 62], ["arm64", 183]]) {
	const binary = readFileSync(new URL(`linux-${architecture}/gori-landlock-run`, resources));
	if (digest(binary) !== manifest.binaries[`linux-${architecture}`]) throw new Error(`Sandbox binary digest mismatch: ${architecture}`);
	if (binary.subarray(0, 4).toString("hex") !== "7f454c46" || binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== machine) throw new Error(`Invalid Linux ELF architecture: ${architecture}`);
	const offset = Number(binary.readBigUInt64LE(32));
	const size = binary.readUInt16LE(54);
	const count = binary.readUInt16LE(56);
	for (let index = 0; index < count; index++) if (binary.readUInt32LE(offset + index * size) === 3) throw new Error(`Sandbox binary is dynamically linked: ${architecture}`);
}
console.log("Sandbox resources: source, digests and static Linux architectures verified.");
