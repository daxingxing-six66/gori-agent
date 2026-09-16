import { WorkspaceConsole } from "@/components/workspace-console";

export default async function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
	const { workspaceId } = await params;
	return <WorkspaceConsole workspaceId={workspaceId} />;
}
