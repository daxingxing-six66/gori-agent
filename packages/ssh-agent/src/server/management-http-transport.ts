import type { SshAgentHttpHandler } from "../api/http-handler.ts";
import { backendMessage } from "../i18n/message.ts";
import { HttpBoundaryError } from "../i18n/public-error.ts";
import { createNodeHttpServer, type CreateNodeHttpServerOptions, type NodeHttpServer, type NodeHttpServerAddress } from "./node-http-server.ts";

export const DEFAULT_API_PORT = 3001;
export const DEFAULT_EVENTS_PORT = 3002;

interface ManagementHttpTransportOptions extends Omit<CreateNodeHttpServerOptions, "port"> {
	port: number;
	eventsPort: number;
}

export interface ManagementHttpAddress extends NodeHttpServerAddress {
	events: NodeHttpServerAddress;
}

/** Separate origins give REST and SSE independent browser connection budgets, with one backend owner. */
export class ManagementHttpTransport {
	readonly #api: NodeHttpServer;
	readonly #events: NodeHttpServer;

	constructor(options: ManagementHttpTransportOptions) {
		if (options.port !== 0 && options.port === options.eventsPort) {
			throw new Error("API and events ports must differ");
		}
		const { eventsPort, ...httpOptions } = options;
		this.#api = createNodeHttpServer({
			...httpOptions,
			handleRequest: channelHandler("api", options.handleRequest),
		});
		this.#events = createNodeHttpServer({
			...httpOptions,
			port: eventsPort,
			handleRequest: channelHandler("events", options.handleRequest),
		});
	}

	async listen(): Promise<ManagementHttpAddress> {
		const api = await this.#api.listen();
		const events = await this.#events.listen();
		return { ...api, events };
	}

	async close(): Promise<void> {
		await Promise.all([this.#api.close(), this.#events.close()]);
	}
}

function channelHandler(channel: "api" | "events", handleRequest: SshAgentHttpHandler): SshAgentHttpHandler {
	return (request) => {
		const path = new URL(request.url).pathname;
		const isEventStream = request.method === "GET" && path.startsWith("/api/") && path.endsWith("/events");
		if (isEventStream !== (channel === "events")) {
			throw new HttpBoundaryError("not_found", 404, backendMessage("common.api_not_found"));
		}
		return handleRequest(request);
	};
}
