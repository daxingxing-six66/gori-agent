import { describe, expect, it } from "vitest";
import { terminalSeccompFilter } from "../src/infrastructure/sandbox/terminal-seccomp-filter.ts";

// Evaluate the actual cBPF resource against seccomp_data, including compat ABI
// and high argument bits. Real-kernel enforcement is tested by the Linux fixture.
function evaluate(arch: number, syscall: number, request = 0n): number {
	const data = Buffer.alloc(64);
	data.writeUInt32LE(syscall, 0);
	data.writeUInt32LE(arch, 4);
	data.writeBigUInt64LE(request, 24);
	const program = terminalSeccompFilter();
	let accumulator = 0;
	for (let pc = 0; pc < program.length / 8; pc++) {
		const offset = pc * 8;
		const code = program.readUInt16LE(offset);
		const value = program.readUInt32LE(offset + 4);
		if (code === 0x20) accumulator = data.readUInt32LE(value);
		else if (code === 0x15) pc += program[offset + (accumulator === value ? 2 : 3)]!;
		else if (code === 0x06) return value;
		else throw new Error(`Unexpected BPF instruction: ${code}`);
	}
	throw new Error("BPF did not return");
}

describe("Terminal seccomp filter", () => {
	it.each([
		["x86_64", 0xc000003e, 16], ["x32", 0xc000003e, 0x40000202],
		["x32 legacy number", 0xc000003e, 0x40000010], ["i386", 0x40000003, 54],
		["aarch64", 0xc00000b7, 29], ["ARM compat", 0x40000028, 54],
	])("denies injected input without blocking normal terminal controls: %s", (_name, arch, ioctl) => {
		for (const request of [0x5412n, 0x541cn, 0xffff_ffff_0000_5412n, 0x1234_5678_0000_541cn]) {
			expect(evaluate(arch, ioctl, request)).toBe(0x00050001);
		}
		for (const request of [0x5401n, 0x5402n, 0x540fn, 0x5410n, 0x5413n, 0x5414n]) {
			expect(evaluate(arch, ioctl, request)).toBe(0x7fff0000);
		}
		// A matching argument on read/fork/exec is not an ioctl request.
		expect(evaluate(arch, 0, 0x5412n)).toBe(0x7fff0000);
		expect(evaluate(arch, 221, 0x541cn)).toBe(0x7fff0000);
	});
	it("fails closed for an unrecognized architecture", () => {
		expect(evaluate(0, 16, 0x5412n)).toBe(0x00050026);
		expect(evaluate(0x80000016, 29, 0x5412n)).toBe(0x00050026);
	});
});
