"use client";

import { useCallback, useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { errorMessage } from "@/shared/errors/api-error";

export function useLocalizedErrorMessage(): (error: unknown) => string {
	const intl = useIntl();
	const intlRef = useRef(intl);
	useEffect(() => {
		intlRef.current = intl;
	}, [intl]);
	return useCallback(
		(error: unknown) => errorMessage(error, intlRef.current.formatMessage({ id: "common.error.requestFailed" })),
		[],
	);
}
