import type { SftpPathInput } from "../../application/ssh-channel-broker.ts";
import { FileTransferError } from "../../domain/file-transfer.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";

export const MAX_CONCURRENT_SFTP_TRANSFERS = 20;
export const MAX_QUEUED_SFTP_TRANSFERS = 3000;

type TransferInput = Pick<SftpPathInput, "target" | "signal">;
interface Waiter {
	target: SshTargetSnapshot;
	grant(): void;
	reject(error: Error): void;
}

/** One FIFO budget shared by uploads and downloads on the backend's broker. */
export class SftpTransferLimiter {
	#active = 0;
	#closed = false;
	readonly #waiting: Waiter[] = [];

	async run<T>(input: TransferInput, operation: () => Promise<T>, cancellationError: () => Error): Promise<T> {
		await this.#acquire(input, cancellationError);
		try {
			if (input.signal.aborted) throw cancellationError();
			if (this.#closed) throw closedError();
			return await operation();
		} finally {
			this.#active--;
			this.#waiting.shift()?.grant();
		}
	}

	cancelQueued(matches: (target: SshTargetSnapshot) => boolean): void {
		for (const waiter of [...this.#waiting]) {
			if (matches(waiter.target)) waiter.reject(new FileTransferError("transfer_cancelled", "Queued transfer target was invalidated", 409));
		}
	}

	close(): void {
		this.#closed = true;
		for (const waiter of [...this.#waiting]) waiter.reject(closedError());
	}

	#acquire(input: TransferInput, cancellationError: () => Error): Promise<void> {
		if (input.signal.aborted) return Promise.reject(cancellationError());
		if (this.#closed) return Promise.reject(closedError());
		if (this.#active < MAX_CONCURRENT_SFTP_TRANSFERS) {
			this.#active++;
			return Promise.resolve();
		}
		if (this.#waiting.length >= MAX_QUEUED_SFTP_TRANSFERS) {
			return Promise.reject(new FileTransferError("transfer_queue_full", "File transfer queue is full. Try again later.", 429));
		}
		return new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				input.signal.removeEventListener("abort", onAbort);
				const index = this.#waiting.indexOf(waiter);
				if (index !== -1) this.#waiting.splice(index, 1);
			};
			const waiter: Waiter = {
				target: input.target,
				grant: () => { cleanup(); this.#active++; resolve(); },
				reject: (error) => { cleanup(); reject(error); },
			};
			const onAbort = () => waiter.reject(cancellationError());
			this.#waiting.push(waiter);
			input.signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

function closedError(): FileTransferError {
	return new FileTransferError("transfer_cancelled", "File transfer service is closed", 409);
}
