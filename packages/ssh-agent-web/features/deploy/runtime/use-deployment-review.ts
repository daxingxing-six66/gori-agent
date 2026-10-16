"use client";

import { useEffect, useState } from "react";
import type { DeploymentRun } from "../model/deployment";
import { deploymentReviewState } from "../model/deployment-review";

/** One expiry snapshot feeds both the review and pending indicator, without polling Chat. */
export function useDeploymentReview(run: DeploymentRun | null) {
	const [, invalidate] = useState(0);
	const expiresAt = nextApprovalExpiry(run, Date.now());
	useEffect(() => {
		if (expiresAt === undefined) return;
		const delay = Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now() + 1));
		const timer = setTimeout(() => invalidate((value) => value + 1), delay);
		return () => clearTimeout(timer);
	}, [expiresAt]);
	return run ? deploymentReviewState(run) : null;
}

function nextApprovalExpiry(run: DeploymentRun | null, now: number): number | undefined {
	if (!run || (run.status !== "preparing" && run.status !== "recovering")) return undefined;
	const times = Object.values(run.fullAccessApprovals ?? {}).flatMap((approval) =>
		approval?.status === "approved" && approval.expiresAt !== undefined && approval.expiresAt > now ? [approval.expiresAt] : []);
	return times.length > 0 ? Math.min(...times) : undefined;
}
