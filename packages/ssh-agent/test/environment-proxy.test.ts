import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { getGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { installEnvironmentProxy } from "../src/server/environment-proxy.ts";

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	return address.port;
}

async function mockProxy() {
	const targets: string[] = [];
	const sockets = new Set<Duplex>();
	const server = createServer();
	server.on("connect", (request, socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.once("close", () => sockets.delete(socket));
		targets.push(request.url!);
		if (request.url?.endsWith(":443")) {
			// Routing is observable before TLS. Real HTTPS connectivity is checked separately.
			socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied"));
	});
	const port = await listen(server);
	return {
		url: `http://127.0.0.1:${port}`,
		targets,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("Node environment HTTP proxy", () => {
	it("leaves the dispatcher alone when HTTP/HTTPS proxies are absent", () => {
		const previous = getGlobalDispatcher();
		expect(installEnvironmentProxy({})).toBeUndefined();
		expect(getGlobalDispatcher()).toBe(previous);
	});

	it("routes native fetch through lowercase HTTP/HTTPS settings and restores the dispatcher", async () => {
		const http = await mockProxy();
		const https = await mockProxy();
		const previous = getGlobalDispatcher();
		const proxy = installEnvironmentProxy({
			http_proxy: http.url, https_proxy: https.url,
			HTTP_PROXY: "invalid-secret-value", HTTPS_PROXY: "invalid-secret-value",
		});
		try {
			const response = await fetch("http://model.invalid/v1/models", { signal: AbortSignal.timeout(2000) });
			expect(await response.text()).toBe("proxied");
			await expect(fetch("https://auth.invalid/.well-known/jwks.json", { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
			expect(http.targets).toEqual(["model.invalid:80"]);
			expect(https.targets).toEqual(["auth.invalid:443"]);
		} finally {
			await proxy?.close();
			await Promise.all([http.close(), https.close()]);
		}
		expect(getGlobalDispatcher()).toBe(previous);
	});

	it("keeps loopback direct and preserves an explicit NO_PROXY wildcard", async () => {
		const remote = await mockProxy();
		const server = createServer((_request, response) => response.end("direct"));
		const port = await listen(server);
		try {
			for (const noProxy of ["", "*", "internal.example"]) {
				const proxy = installEnvironmentProxy({ HTTP_PROXY: remote.url, NO_PROXY: noProxy });
				try {
					const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
					expect(await response.text()).toBe("direct");
				} finally { await proxy?.close(); }
			}
			expect(remote.targets).toEqual([]);
		} finally {
			await remote.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("applies caller NO_PROXY rules to external hostnames", async () => {
		const remote = await mockProxy();
		const proxy = installEnvironmentProxy({ HTTP_PROXY: remote.url, NO_PROXY: "model.invalid" });
		try {
			await expect(fetch("http://model.invalid/test", { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
			expect(remote.targets).toEqual([]);
		} finally {
			await proxy?.close();
			await remote.close();
		}
	});

	it("rejects malformed settings without exposing credentials", () => {
		for (const value of ["socks5://user:secret@localhost:7890", "http://user:secret@invalid:bad-port"]) {
			expect(() => installEnvironmentProxy({ HTTPS_PROXY: value })).toThrow("Invalid HTTPS_PROXY: expected an HTTP/HTTPS proxy URL.");
		}
	});
});
