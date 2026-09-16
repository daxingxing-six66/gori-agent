export interface HostKeyProbeInput {
	hostname: string;
	port: number;
	timeoutMs: number;
}

export interface ObservedHostKey {
	algorithm: string;
	fingerprint: string;
}

export interface HostKeyProbe {
	probe(input: HostKeyProbeInput): Promise<ObservedHostKey>;
}
