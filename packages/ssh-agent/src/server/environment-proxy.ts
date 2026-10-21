import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

export interface EnvironmentProxy {
	close(): Promise<void>;
}

/** Install once at the CLI boundary so native fetch and SDK fetch share the same routing. */
export function installEnvironmentProxy(environment: NodeJS.ProcessEnv = process.env): EnvironmentProxy | undefined {
	const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY ?? "";
	const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY ?? "";
	if (!httpProxy && !httpsProxy) return undefined;
	validateProxy(httpProxy, "HTTP_PROXY");
	validateProxy(httpsProxy, "HTTPS_PROXY");
	const bypass = environment.no_proxy ?? environment.NO_PROXY ?? "";
	const noProxy = bypass.trim() === "*" ? "*" : [bypass, "localhost", "127.0.0.1", "[::1]"].filter(Boolean).join(",");
	const previous = getGlobalDispatcher();
	let proxy: EnvHttpProxyAgent;
	try {
		proxy = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
	} catch {
		// Proxy URLs can contain credentials. Do not propagate the constructor's raw URL/error.
		throw new Error("Cannot configure HTTP_PROXY/HTTPS_PROXY. Check the HTTP/HTTPS proxy URLs.");
	}
	setGlobalDispatcher(proxy);
	return {
		async close() {
			if (getGlobalDispatcher() === proxy) setGlobalDispatcher(previous);
			await proxy.close();
		},
	};
}

function validateProxy(value: string, variable: string): void {
	if (!value) return;
	try {
		const url = new URL(value);
		if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) return;
	} catch {
		// Only the variable name is safe to display.
	}
	throw new Error(`Invalid ${variable}: expected an HTTP/HTTPS proxy URL.`);
}
