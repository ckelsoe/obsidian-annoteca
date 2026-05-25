// Position drift detection (F-234). Stores a small "anchor signature" per
// commented marker (surrounding text snippets) so we can flag comments whose
// surrounding prose has changed since the last snapshot.

import type { Comment } from "./types";

export interface PositionSnapshot {
	before: string;
	after: string;
}

const SNIPPET_LENGTH = 80;

export function captureSnapshot(content: string, c: Comment): PositionSnapshot {
	const before = content.slice(Math.max(0, c.marker.start - SNIPPET_LENGTH), c.marker.start);
	const after = content.slice(c.marker.end, Math.min(content.length, c.marker.end + SNIPPET_LENGTH));
	return { before: normalize(before), after: normalize(after) };
}

function normalize(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

export interface DriftFinding {
	path: string;
	comment: Comment;
	prev: PositionSnapshot;
	current: PositionSnapshot;
}

export function detectDrift(
	content: string,
	path: string,
	comments: Comment[],
	priorSnapshots: Record<string, PositionSnapshot>,
): { findings: DriftFinding[]; refreshedSnapshots: Record<string, PositionSnapshot> } {
	const refreshed = { ...priorSnapshots };
	const findings: DriftFinding[] = [];
	for (const c of comments) {
		if (!c.id) continue;
		const current = captureSnapshot(content, c);
		const prev = priorSnapshots[c.id];
		if (prev) {
			if (prev.before !== current.before || prev.after !== current.after) {
				findings.push({ path, comment: c, prev, current });
			}
		}
		refreshed[c.id] = current;
	}
	return { findings, refreshedSnapshots: refreshed };
}
