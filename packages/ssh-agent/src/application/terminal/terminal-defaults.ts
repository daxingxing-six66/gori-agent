export const TERMINAL_DEFAULTS = {
	geometry: {
		rows: 36,
		cols: 120,
		minRows: 12,
		maxRows: 120,
		minCols: 40,
		maxCols: 320,
	},
	capacity: {
		processTerminalSessions: 16,
		connectionTerminalSessions: 4,
		attachmentsPerTerminal: 4,
	},
	replay: {
		outputBytes: 2 * 1024 * 1024,
		frames: 4096,
		subscriberPendingBytes: 512 * 1024,
		scrollbackRows: 2000,
	},
	input: {
		maxBytes: 32 * 1024,
	},
	observation: {
		promptSettleMs: 150,
		finiteQuietMs: 800,
		finiteMaxWaitMs: 30_000,
		interactiveQuietMs: 500,
		interactiveMaxWaitMs: 15_000,
		streamingSnapshotMs: 1500,
		streamingMaxWaitMs: 3000,
		maxRawBytes: 256 * 1024,
		maxAgentViewBytes: 64 * 1024,
	},
	lifecycle: {
		openTimeoutMs: 30_000,
		idleTtlMs: 2 * 60 * 60 * 1000,
		idleScanIntervalMs: 60_000,
		reconnectGraceMs: 30_000,
		bootstrapTimeoutMs: 15_000,
		sseHeartbeatMs: 15_000,
		channelCloseTimeoutMs: 5000,
		serverShutdownTimeoutMs: 10_000,
	},
} as const;

export type TerminalDefaults = typeof TERMINAL_DEFAULTS;
