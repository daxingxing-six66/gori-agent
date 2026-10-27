// Linux seccomp_data and classic BPF UAPI. All supported ABIs are little endian.
type Instruction = readonly [code: number, jt: number, jf: number, value: number];
const LOAD_WORD = 0x20;
const JUMP_EQUAL = 0x15;
const RETURN = 0x06;
const ALLOW = 0x7fff0000;
const DENY = 0x00050000 | 1; // SECCOMP_RET_ERRNO | EPERM
const UNSUPPORTED = 0x00050000 | 38; // ENOSYS; an unknown ABI cannot execute unfiltered.

/**
 * Keeps ordinary terminal ioctls, but denies input injection and Linux-console
 * controls. Match the kernel's low 32-bit ioctl request, including compat ABIs.
 * This supplements filesystem confinement; it is not a general syscall sandbox.
 */
export function terminalSeccompFilter(): Buffer {
	const instructions: Instruction[] = [[LOAD_WORD, 0, 0, 4]]; // seccomp_data.arch
	for (const { arch, ioctl } of [
		{ arch: 0xc000003e, ioctl: [16, 0x40000202, 0x40000010] }, // x86_64, x32
		{ arch: 0x40000003, ioctl: [54] }, // i386
		{ arch: 0xc00000b7, ioctl: [29] }, // aarch64
		{ arch: 0x40000028, ioctl: [54] }, // ARM EABI
	]) {
		const block: Instruction[] = [
			[LOAD_WORD, 0, 0, 0], // seccomp_data.nr
			...ioctl.map((number, index): Instruction => [JUMP_EQUAL, ioctl.length - index, 0, number]),
			[RETURN, 0, 0, ALLOW],
			[LOAD_WORD, 0, 0, 24], // seccomp_data.args[1], low word (ioctl request)
			[JUMP_EQUAL, 1, 0, 0x5412], // TIOCSTI
			[JUMP_EQUAL, 0, 1, 0x541c], // TIOCLINUX
			[RETURN, 0, 0, DENY],
			[RETURN, 0, 0, ALLOW],
		];
		instructions.push([JUMP_EQUAL, 0, block.length, arch], ...block);
	}
	instructions.push([RETURN, 0, 0, UNSUPPORTED]);
	const bytes = Buffer.alloc(instructions.length * 8);
	instructions.forEach(([code, jt, jf, value], index) => {
		bytes.writeUInt16LE(code, index * 8);
		bytes.writeUInt8(jt, index * 8 + 2);
		bytes.writeUInt8(jf, index * 8 + 3);
		bytes.writeUInt32LE(value, index * 8 + 4);
	});
	return bytes;
}
