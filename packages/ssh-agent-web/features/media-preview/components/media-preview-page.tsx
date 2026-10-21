"use client";

import { Image, LoaderCircle, Music2, RefreshCw, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { errorMessage } from "@/shared/errors/api-error";
import { mediaPreviewApi } from "../api/media-preview-api";
import type { MediaDocument, MediaFile } from "../model/media-file";
import { useMediaFile } from "../runtime/use-media-file";
import "./media-preview.css";

export function MediaPreviewPage({ sessionId, document, active }: { sessionId: string; document: MediaDocument; active: boolean }) {
	const intl = useIntl();
	const [retry, setRetry] = useState(0);
	const revision = document.revision + retry;
	const { file, error } = useMediaFile(sessionId, document.path, revision);
	return <section className="media-preview" aria-label={intl.formatMessage({ id: "mediaPreview.label" }, { name: document.name })}>
		<header className="media-preview-header">
			{file?.kind === "audio" ? <Music2 size={15} aria-hidden="true" /> : file?.kind === "video" ? <Video size={15} aria-hidden="true" /> : <Image size={15} aria-hidden="true" />}
			<span title={file?.path ?? document.path}>{file?.path ?? document.path}</span>
			<button type="button" onClick={() => setRetry((value) => value + 1)} aria-label={intl.formatMessage({ id: "mediaPreview.refresh" })} title={intl.formatMessage({ id: "mediaPreview.refresh" })}><RefreshCw size={14} aria-hidden="true" /></button>
		</header>
		{file ? <div className="media-preview-meta"><span>{file.mimeType}</span><span>{intl.formatNumber(file.size)} B</span></div> : null}
		{error ? <div className="media-preview-state" role="alert"><p>{errorMessage(error, intl.formatMessage({ id: "mediaPreview.failed" }))}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>{intl.formatMessage({ id: "mediaPreview.retry" })}</button></div>
			: file ? <MediaPlayer key={`${sessionId}:${document.id}:${revision}`} file={file} active={active}
				src={mediaPreviewApi.contentUrl(sessionId, file.path, revision)} />
			: <div className="media-preview-state" role="status"><LoaderCircle size={18} className="animate-spin" aria-hidden="true" />{intl.formatMessage({ id: "mediaPreview.loading" })}</div>}
	</section>;
}

function MediaPlayer({ file, src, active }: { file: MediaFile; src: string; active: boolean }) {
	const intl = useIntl();
	const [failed, setFailed] = useState(false);
	const videoRef = useRef<HTMLVideoElement>(null);
	const audioRef = useRef<HTMLAudioElement>(null);
	useEffect(() => {
		const video = videoRef.current, audio = audioRef.current;
		if (!active) { video?.pause(); audio?.pause(); }
		return () => { video?.pause(); audio?.pause(); };
	}, [active]);
	return <div className="media-preview-content app-scrollbar">
		{failed ? <p role="alert" className="media-preview-state">{intl.formatMessage({ id: "mediaPreview.playbackFailed" })}</p>
			: file.kind === "image" ? <img className="media-preview-image" src={src} alt={file.name} onError={() => setFailed(true)} />
			: file.kind === "video" ? <video ref={videoRef} className="media-preview-video" controls playsInline preload="metadata" src={src} aria-label={file.name} onError={() => setFailed(true)} />
			: <div className="media-preview-audio"><Music2 size={40} aria-hidden="true" /><p>{file.name}</p><audio ref={audioRef} controls preload="metadata" src={src} aria-label={file.name} onError={() => setFailed(true)} /></div>}
	</div>;
}
