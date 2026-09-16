export const maximumImageDimension = 2_048;
export const maximumImageUploadBytes = 20 * 1024 * 1024;

export interface ImageDimensions {
	width: number;
	height: number;
}

export function fitImageWithinMaximumDimension({ width, height }: ImageDimensions): ImageDimensions {
	if (width <= maximumImageDimension && height <= maximumImageDimension) return { width, height };
	const scale = maximumImageDimension / Math.max(width, height);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}
