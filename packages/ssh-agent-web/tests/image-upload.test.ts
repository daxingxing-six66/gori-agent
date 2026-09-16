import { describe, expect, it } from "vitest";
import { fitImageWithinMaximumDimension, maximumImageDimension } from "../features/session/model/image-upload.ts";

describe("image upload preprocessing", () => {
	it("keeps images within the maximum longest side without changing their aspect ratio", () => {
		expect(fitImageWithinMaximumDimension({ width: 4_000, height: 3_000 })).toEqual({ width: maximumImageDimension, height: 1_536 });
		expect(fitImageWithinMaximumDimension({ width: 1_500, height: 3_000 })).toEqual({ width: 1_024, height: maximumImageDimension });
	});

	it("does not enlarge images that already fit the target bounds", () => {
		expect(fitImageWithinMaximumDimension({ width: 1_920, height: 1_080 })).toEqual({ width: 1_920, height: 1_080 });
	});
});
