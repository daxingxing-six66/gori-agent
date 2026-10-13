/** Rates for the default-route interface, from the remote server's perspective. */
export interface RemoteNetworkMetrics {
	interfaceName: string;
	receiveBytesPerSecond: number | null;
	transmitBytesPerSecond: number | null;
}
