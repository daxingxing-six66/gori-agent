/** Aggregate throughput of visible leaf whole-block devices, from the remote host. */
export interface RemoteDiskIoMetrics {
	readBytesPerSecond: number | null;
	writeBytesPerSecond: number | null;
}
