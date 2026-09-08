import type { FindingSeverity, PlumblineFinding } from './plumbline-client';

// What the Findings lane draws, as data rather than DOM.
//
// Kept out of the renderer so it can be tested: that module imports Obsidian,
// and this project's jest runs on the 'node' environment. Same split the rest of
// the hub tabs would benefit from.

// Severities shown as their own rows. Anything below collapses into one counted
// row: never silently hidden, always counted, one click to expand. Contract 3.3.
const ABOVE_FLOOR: readonly FindingSeverity[] = ['error', 'warning'];

// Rows drawn before the lane stops. A pathological note should not freeze the
// sidebar, and nobody reads past the first screen of a side panel.
export const LANE_ROW_CAP = 40;

export interface FindingRow {
	key: string;
	ruleSlug: string;
	severity: FindingSeverity;
	message: string;
	// 1-based, matching the editor's own gutter. Plumbline's panel located
	// sections this way from PR #26 onward, after the paragraph ordinal turned
	// out to count headings and name a paragraph nobody could find by counting.
	line: number;
	// Offset of the first occurrence, for navigating.
	start: number;
	end: number;
	// The flagged words, so the row says what it is about without the note open.
	text: string;
	// How many times this rule fired. More than one means the row stands for a
	// group, which is what Plumbline's rollup produced.
	count: number;
}

export interface FindingsLaneModel {
	rows: FindingRow[];
	// Collapsed suggestions: counted, never dropped.
	collapsed: FindingRow[];
	// Rows the cap is hiding, across both lists.
	hidden: number;
}

// One-based line number of a character offset, counted by newlines before it.
export function lineOf(text: string, offset: number): number {
	let line = 1;
	const limit = Math.min(offset, text.length);
	for (let i = 0; i < limit; i++) {
		if (text[i] === '\n') line += 1;
	}
	return line;
}

function toRow(finding: PlumblineFinding, text: string): FindingRow | null {
	// Document order, so a rolled-up finding reports where it FIRST fired rather
	// than wherever the engine happened to list first.
	const occurrences = [...finding.occurrences].sort(
		(a, b) => a.start - b.start || a.end - b.end,
	);
	const first = occurrences[0];
	if (first === undefined) return null;
	return {
		// The key of the first occurrence, which is what a promotion carries, not
		// the finding's group key. Contract 7.2: promotion is per occurrence.
		key: first.key,
		ruleSlug: finding.ruleSlug,
		severity: finding.severity,
		message: finding.message,
		line: lineOf(text, first.start),
		start: first.start,
		end: first.end,
		text: text.slice(first.start, first.end),
		count: occurrences.length,
	};
}

// Rank, apply the severity floor, and cap.
//
// The ORDER is Plumbline's: `priority` comes across the boundary already
// computed (contract 3.3), so the lane and Plumbline's own panel rank the same
// way. Recomputing it here would mean two copies of a formula and two rankings
// the first time one is tuned.
export function buildFindingsLane(
	findings: readonly PlumblineFinding[],
	text: string,
	cap: number = LANE_ROW_CAP,
): FindingsLaneModel {
	const ranked = [...findings].sort(
		(a, b) =>
			b.priority - a.priority || a.ruleSlug.localeCompare(b.ruleSlug),
	);
	const above: FindingRow[] = [];
	const below: FindingRow[] = [];
	for (const finding of ranked) {
		const row = toRow(finding, text);
		if (row === null) continue;
		if (ABOVE_FLOOR.includes(finding.severity)) above.push(row);
		else below.push(row);
	}
	const rows = above.slice(0, Math.max(0, cap));
	const remaining = Math.max(0, cap - rows.length);
	const collapsed = below.slice(0, remaining);
	return {
		rows,
		collapsed,
		hidden: above.length - rows.length + (below.length - collapsed.length),
	};
}

// The one-line summary the lane header shows.
export function laneSummary(model: FindingsLaneModel): string {
	const counts: Record<FindingSeverity, number> = {
		error: 0,
		warning: 0,
		suggestion: 0,
	};
	for (const row of [...model.rows, ...model.collapsed]) {
		counts[row.severity] += row.count;
	}
	const parts: string[] = [];
	for (const severity of ['error', 'warning', 'suggestion'] as const) {
		const n = counts[severity];
		if (n > 0) parts.push(`${n} ${severity}${n === 1 ? '' : 's'}`);
	}
	return parts.length === 0 ? 'Nothing flagged.' : parts.join(', ');
}
