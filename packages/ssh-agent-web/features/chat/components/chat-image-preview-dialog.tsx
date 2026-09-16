"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl, type IntlShape } from "react-intl";

export interface ChatImagePreviewItem {
	id: string;
	name: string;
	size: number;
	src: string;
	dimensions?: ImageDimensions;
}

export interface ImageDimensions {
	width: number;
	height: number;
}

export function ChatImagePreviewDialog({ images, initialIndex, onClose }: {
	images: readonly ChatImagePreviewItem[];
	initialIndex: number;
	onClose(): void;
}) {
	const intl = useIntl();
	const dialogRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLElement | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(() => Math.min(Math.max(initialIndex, 0), images.length - 1));
	const image = images[selectedIndex];
	const hasMultipleImages = images.length > 1;

	useEffect(() => {
		triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.focus();
		return () => triggerRef.current?.focus();
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}
			if (!hasMultipleImages) return;
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				setSelectedIndex((index) => index === 0 ? images.length - 1 : index - 1);
			}
			if (event.key === "ArrowRight") {
				event.preventDefault();
				setSelectedIndex((index) => index === images.length - 1 ? 0 : index + 1);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [hasMultipleImages, images.length, onClose]);

	if (!image) return null;
	const selectPrevious = () => setSelectedIndex((index) => index === 0 ? images.length - 1 : index - 1);
	const selectNext = () => setSelectedIndex((index) => index === images.length - 1 ? 0 : index + 1);

	return createPortal(
		<div className="fixed inset-0 z-[120] grid place-items-center bg-black/65 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div ref={dialogRef} className="flex h-[min(820px,calc(100dvh-32px))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#181b18]/95 shadow-2xl outline-none" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: "chat.attachment.preview" }, { name: image.name })} tabIndex={-1}>
				<header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-white sm:px-5">
					<div className="min-w-0"><p className="truncate text-[12px] font-semibold">{image.name}</p><p className="mt-0.5 text-[10px] text-white/60">{formatImageMetadata(intl, image)}</p></div>
					<div className="flex shrink-0 items-center gap-1.5">
						{hasMultipleImages ? <span className="px-2 text-[10px] tabular-nums text-white/60">{intl.formatMessage({ id: "chat.attachment.preview.position" }, { current: selectedIndex + 1, total: images.length })}</span> : null}
						<button type="button" className="grid h-8 w-8 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" onClick={onClose} aria-label={intl.formatMessage({ id: "chat.attachment.preview.close" })}><X size={17} /></button>
					</div>
				</header>
				<div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/20 p-4 sm:p-8">
					<img src={image.src} alt={image.name} className="max-h-full max-w-full select-none object-contain" />
					{hasMultipleImages ? <>
						<button type="button" className="absolute left-3 grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/35 text-white transition hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:left-5" onClick={selectPrevious} aria-label={intl.formatMessage({ id: "chat.attachment.preview.previous" })}><ChevronLeft size={20} /></button>
						<button type="button" className="absolute right-3 grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/35 text-white transition hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:right-5" onClick={selectNext} aria-label={intl.formatMessage({ id: "chat.attachment.preview.next" })}><ChevronRight size={20} /></button>
					</> : null}
				</div>
			</div>
		</div>,
		document.body,
	);
}

export function formatImageMetadata(intl: IntlShape, image: ChatImagePreviewItem): string {
	const dimensions = image.dimensions
		? intl.formatMessage({ id: "chat.attachment.dimensions" }, { width: image.dimensions.width, height: image.dimensions.height })
		: intl.formatMessage({ id: "chat.attachment.dimensionsLoading" });
	return `${dimensions} · ${formatBytes(image.size)}`;
}

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	const units = ["KiB", "MiB", "GiB"];
	let amount = value;
	let index = -1;
	do {
		amount /= 1024;
		index += 1;
	} while (amount >= 1024 && index < units.length - 1);
	return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
