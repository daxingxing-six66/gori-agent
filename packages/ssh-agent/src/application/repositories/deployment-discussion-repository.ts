import type { DeploymentDiscussion } from "../../domain/deployment.ts";

export interface DeploymentDiscussionRunBinding {
	discussionId: string;
	sessionId: string;
	agentRunId: string;
	revision: number;
}

export interface DeploymentDiscussionRepository {
	find(sessionId: string, id: string): DeploymentDiscussion | undefined;
	findActive(sessionId: string): DeploymentDiscussion | undefined;
	findRunBinding(sessionId: string, agentRunId: string): DeploymentDiscussionRunBinding | undefined;
	findLatestRunBinding(discussionId: string): DeploymentDiscussionRunBinding | undefined;
	insert(discussion: DeploymentDiscussion): void;
	updateDiscussing(discussion: DeploymentDiscussion, expectedRevision: number): boolean;
	insertRunBinding(binding: DeploymentDiscussionRunBinding): void;
}
