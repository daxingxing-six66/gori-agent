"use client";

import { useServerMetrics } from "../runtime/use-server-metrics";
import { ServerMetricsStrip } from "./server-metrics-strip";

export function SessionServerMetrics({ workspaceId }: { workspaceId: string }) {
	const state = useServerMetrics(workspaceId);
	return <ServerMetricsStrip state={state} />;
}
