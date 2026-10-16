const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let value = formatters.get(timeZone);
	if (!value) {
		value = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
		formatters.set(timeZone, value);
	}
	return value;
}

function parts(timestamp: number, timeZone: string): Record<string, string> {
	return Object.fromEntries(formatter(timeZone).formatToParts(timestamp).map((part) => [part.type, part.value]));
}

export function statisticsDay(timestamp: number, timeZone: string): string {
	const value = parts(timestamp, timeZone);
	return `${value.year}-${value.month}-${value.day}`;
}

export function shiftStatisticsDay(date: string, days: number): string {
	const value = new Date(`${date}T12:00:00Z`);
	value.setUTCDate(value.getUTCDate() + days);
	return value.toISOString().slice(0, 10);
}

/** Resolve civil midnight in an IANA zone, including non-hour offsets and DST. */
export function statisticsMidnight(date: string, timeZone: string): number {
	const target = Date.parse(`${date}T00:00:00Z`);
	let candidate = target;
	for (let attempt = 0; attempt < 4; attempt++) {
		const value = parts(candidate, timeZone);
		const displayed = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day),
			Number(value.hour), Number(value.minute), Number(value.second));
		const difference = target - displayed;
		if (difference === 0) return candidate;
		candidate += difference;
	}
	// Some zones move the clock at midnight. Use the first instant of the civil day
	// when 00:00 itself does not exist, rather than leaking into the previous date.
	let low = target - 36 * 3600_000, high = target + 36 * 3600_000;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (statisticsDay(middle, timeZone) < date) low = middle + 1; else high = middle;
	}
	return low;
}

export function statisticsDates(first: string, last: string): string[] {
	const result: string[] = [];
	for (let date = first; date <= last; date = shiftStatisticsDay(date, 1)) result.push(date);
	return result;
}
