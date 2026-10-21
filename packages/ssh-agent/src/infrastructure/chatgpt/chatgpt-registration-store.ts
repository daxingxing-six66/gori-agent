import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChatGptRegistration {
	hostId: string;
	clientId?: string;
	subject?: string;
}

/** Installation identity and registration only; tokens belong in the encrypted credential store. */
export class ChatGptRegistrationStore {
	private value: ChatGptRegistration;
	private readonly path: string | undefined;

	constructor(path?: string) {
		this.path = path;
		if (path) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			try {
				writeFileSync(path, JSON.stringify({ hostId: `urn:uuid:${randomUUID()}` }), { flag: "wx", mode: 0o600 });
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isRegistration(value)) throw new Error("Invalid ChatGPT installation registration");
			this.value = value;
		} else {
			this.value = { hostId: `urn:uuid:${randomUUID()}` };
		}
	}

	read(): ChatGptRegistration { return { ...this.value }; }

	save(clientId: string, subject?: string): void {
		const value = { hostId: this.value.hostId, clientId, ...(subject ? { subject } : {}) };
		if (this.path) {
			const temporary = `${this.path}.${randomUUID()}.tmp`;
			writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
			renameSync(temporary, this.path);
		}
		this.value = value;
	}
}

function isRegistration(value: unknown): value is ChatGptRegistration {
	if (!value || typeof value !== "object" || !("hostId" in value)) return false;
	return typeof value.hostId === "string" && /^urn:uuid:[0-9a-f-]{36}$/i.test(value.hostId) &&
		(!("clientId" in value) || typeof value.clientId === "string") &&
		(!("subject" in value) || typeof value.subject === "string");
}
