// Position drift detection (F-234). Stores a small "anchor signature" per
// commented marker (surrounding text snippets) so we can flag comments whose
// surrounding prose has changed since the last snapshot.

import type { Comment } from './types';

export interface PositionSnapshot {
	before: string;
	after: string;
}

const SNIPPET_LENGTH = 80;

export function captureSnapshot(content: string, c: Comment): PositionSnapshot {
	const before = content.slice(
		Math.max(0, c.marker.start - SNIPPET_LENGTH),
		c.marker.start,
	);
	const after = content.slice(
		c.marker.end,
		Math.min(content.length, c.marker.end + SNIPPET_LENGTH),
	);
	return { before: normalize(before), after: normalize(after) };
}

function normalize(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
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
	// The same note as raw file text, when it differs from `content` (Windows
	// line endings). Snapshots were once captured from raw text at raw
	// offsets, and on a CRLF note that window covers different characters. A
	// baseline that still matches the raw capture is that older basis, not
	// drift: it is refreshed without a finding.
	legacy?: { content: string; comments: Comment[] },
): {
	findings: DriftFinding[];
	refreshedSnapshots: Record<string, PositionSnapshot>;
} {
	const refreshed = { ...priorSnapshots };
	const findings: DriftFinding[] = [];
	for (const c of comments) {
		if (!c.id) continue;
		const current = captureSnapshot(content, c);
		const prev = priorSnapshots[c.id];
		if (prev) {
			if (
				!sameSnapshot(prev, current) &&
				!matchesLegacyBasis(prev, c.id, legacy)
			) {
				findings.push({ path, comment: c, prev, current });
			}
		}
		refreshed[c.id] = current;
	}
	return { findings, refreshedSnapshots: refreshed };
}

function sameSnapshot(a: PositionSnapshot, b: PositionSnapshot): boolean {
	return a.before === b.before && a.after === b.after;
}

function matchesLegacyBasis(
	prev: PositionSnapshot,
	id: string,
	legacy: { content: string; comments: Comment[] } | undefined,
): boolean {
	if (!legacy) return false;
	const old = legacy.comments.find((c) => c.id === id);
	return (
		old !== undefined &&
		sameSnapshot(prev, captureSnapshot(legacy.content, old))
	);
}
