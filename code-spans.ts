// Where inline code spans are in a stretch of text, by CommonMark's rule: a
// backtick run opens one, and the next run of exactly the same length closes
// it; a run with no partner is literal backticks, and scanning resumes after
// it. Shared by the importer (code it must not convert) and the closer planner
// (code a closer must not land in), which had a copy each.
//
// No dependencies.

// Every span, as [open, close + run), in order. Each run's next same-length run
// is found in one pass from the end, so text full of unmatched backticks is not
// searched to its end once per run, which made both copies quadratic.
export function inlineCodeSpans(para: string): [number, number][] {
	const runs: { at: number; len: number }[] = [];
	for (let i = 0; i < para.length;) {
		if (para.charAt(i) !== '`') {
			i += 1;
			continue;
		}
		const len = runLength(para, i);
		runs.push({ at: i, len });
		i += len;
	}
	const nextSame: number[] = new Array<number>(runs.length).fill(-1);
	const seen = new Map<number, number>();
	for (let k = runs.length - 1; k >= 0; k--) {
		const run = runs[k];
		if (run === undefined) continue;
		nextSame[k] = seen.get(run.len) ?? -1;
		seen.set(run.len, k);
	}
	const out: [number, number][] = [];
	for (let k = 0; k < runs.length;) {
		const run = runs[k];
		const close = nextSame[k] ?? -1;
		const closing = runs[close];
		if (run === undefined) break;
		if (closing === undefined) {
			k += 1;
			continue;
		}
		out.push([run.at, closing.at + closing.len]);
		k = close + 1;
	}
	return out;
}

// The length of the backtick run starting at `at`.
function runLength(text: string, at: number): number {
	let n = 0;
	while (text.charAt(at + n) === '`') n += 1;
	return n;
}
