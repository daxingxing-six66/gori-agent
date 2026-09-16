import { WorkspaceSidebar } from "@/components/workspace-sidebar";

export default function Home() {
	return (
		<div className="flex h-dvh overflow-hidden bg-canvas text-ink">
			<WorkspaceSidebar />
			<main className="min-w-0 flex-1" />
		</div>
	);
}
