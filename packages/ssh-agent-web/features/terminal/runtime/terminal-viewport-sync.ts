import { TERMINAL_UI_DEFAULTS } from "../model/terminal-ui-defaults";

interface Geometry { rows: number; cols: number; }
interface Options {
	viewport: Pick<HTMLElement, "clientWidth" | "clientHeight">;
	bounds: { minRows: number; maxRows: number; minCols: number; maxCols: number };
	measure(): Geometry | undefined;
	geometry(): Geometry;
	isDocumentFocused(): boolean;
	focus(focused: boolean): Promise<{ owner: boolean; ownershipEpoch: number | null }>;
	resize(epoch: number, geometry: Geometry): Promise<void>;
	onOwnerChange(owner: boolean): void;
	onError(error: unknown): void;
}

/** Coordinate viewport visibility and owner-only resize without changing the mirrored grid locally. */
export class TerminalViewportSync {
	readonly #options: Options;
	#live = false;
	#disposed = false;
	#epoch: number | null = null;
	#desiredFocus: boolean | undefined;
	#sentFocus: boolean | undefined;
	#focusing = false;
	#resizing = false;
	#lastResize: { epoch: number; geometry: Geometry } | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: Options) { this.#options = options; }

	ready(): void { this.#live = true; this.refresh(); }

	/** Called for both ResizeObserver and document focus changes, including hidden-to-visible restoration. */
	refresh(): void {
		if (this.#disposed || !this.#live) return;
		this.#desiredFocus = this.#visible() && this.#options.isDocumentFocused();
		if (!this.#desiredFocus) this.ownerChanged(null);
		this.#updateFocus();
		this.#scheduleResize();
	}

	ownerChanged(epoch: number | null): void {
		if (this.#disposed) return;
		const next = this.#visible() && this.#options.isDocumentFocused() ? epoch : null;
		if (next !== this.#epoch) this.#lastResize = null;
		this.#epoch = next;
		this.#options.onOwnerChange(next !== null);
		this.#scheduleResize();
	}

	/** Only the authoritative terminal.resized event changes geometry and acknowledges a request. */
	geometryChanged(): void {
		if (this.#lastResize && sameGeometry(this.#options.geometry(), this.#lastResize.geometry)) this.#lastResize = null;
		this.#scheduleResize();
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
	}

	#visible(): boolean { return this.#options.viewport.clientWidth > 0 && this.#options.viewport.clientHeight > 0; }

	#updateFocus(): void {
		if (this.#disposed || this.#focusing || this.#desiredFocus === this.#sentFocus) return;
		const focused = this.#desiredFocus;
		if (focused === undefined) return;
		this.#sentFocus = focused;
		this.#focusing = true;
		void this.#options.focus(focused).then((result) => {
			if (!this.#disposed && this.#desiredFocus === focused) this.ownerChanged(result.owner ? result.ownershipEpoch : null);
		}).catch((error: unknown) => {
			if (!this.#disposed && this.#desiredFocus === focused) this.#options.onError(error);
		}).finally(() => {
			this.#focusing = false;
			// Serialize transitions: a late claim cannot arrive after a newer release or restoration.
			this.#updateFocus();
		});
	}

	#scheduleResize(): void {
		clearTimeout(this.#timer);
		if (this.#disposed || !this.#live || this.#epoch === null || !this.#visible() || !this.#options.isDocumentFocused()) return;
		this.#timer = setTimeout(() => this.#resize(), TERMINAL_UI_DEFAULTS.resizeDebounceMs);
	}

	#resize(): void {
		if (this.#disposed || this.#resizing || this.#epoch === null || !this.#visible() || !this.#options.isDocumentFocused()) return;
		const measured = this.#options.measure();
		if (!measured) return;
		const { minRows, maxRows, minCols, maxCols } = this.#options.bounds;
		const geometry = { rows: Math.max(minRows, Math.min(maxRows, measured.rows)),
			cols: Math.max(minCols, Math.min(maxCols, measured.cols)) };
		const epoch = this.#epoch;
		if (sameGeometry(geometry, this.#options.geometry()) ||
			(this.#lastResize?.epoch === epoch && sameGeometry(geometry, this.#lastResize.geometry))) return;
		this.#lastResize = { epoch, geometry };
		this.#resizing = true;
		void this.#options.resize(epoch, geometry).catch((error: unknown) => {
			if (!this.#disposed && this.#epoch === epoch && this.#visible()) this.#options.onError(error);
		}).finally(() => {
			this.#resizing = false;
			// Re-measure the final layout after an in-flight request; never enqueue obsolete dimensions.
			this.#scheduleResize();
		});
	}
}

function sameGeometry(left: Geometry, right: Geometry): boolean { return left.rows === right.rows && left.cols === right.cols; }
