/** Isolate the existing page in place; moving it to a portal would recreate task runtimes. */
export function activateTaskContainerFullscreen(container: HTMLElement, onExit: () => void): () => void {
	const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const siblings = new Map<HTMLElement, boolean>();
	const scope = container.closest<HTMLElement>("[data-task-container-scope]") ?? container.parentElement;
	let branch: HTMLElement = container;
	while (branch !== scope && branch.parentElement) {
		for (const sibling of branch.parentElement.children) {
			if (sibling instanceof HTMLElement && sibling !== branch) {
				siblings.set(sibling, sibling.inert);
				sibling.inert = true;
			}
		}
		branch = branch.parentElement;
	}
	const focusToggle = () => (container.querySelector<HTMLElement>("[data-task-fullscreen-toggle]") ?? container).focus();
	focusToggle();
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
		if (scope && event.target instanceof Node && !scope.contains(event.target)) return;
		if (event.key === "Escape") {
			event.preventDefault();
			onExit();
		}
	};
	document.addEventListener("keydown", onKeyDown);
	return () => {
		document.removeEventListener("keydown", onKeyDown);
		for (const [sibling, inert] of siblings) sibling.inert = inert;
		if (previousFocus?.isConnected && !previousFocus.closest('[inert]') && previousFocus.getClientRects().length > 0) previousFocus.focus();
	};
}
