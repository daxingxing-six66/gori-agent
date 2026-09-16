import { NewSessionChat } from "@/features/session/components/new-session-chat";

export default async function NewSessionPage({ params }: { params: Promise<{ workspaceId: string }> }) {
	const { workspaceId } = await params;
	return <NewSessionChat key={workspaceId} workspaceId={workspaceId} />;
}
