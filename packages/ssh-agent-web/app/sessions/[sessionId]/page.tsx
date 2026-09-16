import { ChatConsole } from "@/features/chat/components/chat-console";

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
	const { sessionId } = await params;
	return <ChatConsole key={sessionId} sessionId={sessionId} />;
}
