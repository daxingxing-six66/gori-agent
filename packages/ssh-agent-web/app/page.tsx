import { WorkspaceSidebar } from "@/components/workspace-sidebar";

export default function Home() {
	return (
		<div className="flex h-dvh overflow-hidden bg-canvas text-ink">
			<WorkspaceSidebar homePage />
			<main className="home-main min-w-0 flex-1" />
		</div>
	);
}
