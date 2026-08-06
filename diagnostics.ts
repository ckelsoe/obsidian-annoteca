// Diagnostics: marker conflict detector (F-232), orphan comment detector
// (F-233), and format validation (F-235). All pure over file content.

import type { Comment } from './types';
import { parseAll, findMalformedMarkers, type MalformedMarker } from './parser';

export interface ConflictFinding {
	path: string;
	prefix: string;
	excerpt: string;
	offset: number;
}

// Matches any `<!-- <namespace>/...` style comment opening. Annoteca's own
// prefix is excluded by the caller. Surfaces other tools (or hand-typed
// prefixes) sharing the namespace shape so the user can rename them.
const NAMESPACED_COMMENT_RE = /<!--\s*([a-z][a-z0-9-]*)\//g;

export function detectMarkerConflicts(
	content: string,
	path: string,
): ConflictFinding[] {
	const out: ConflictFinding[] = [];
	for (const match of content.matchAll(NAMESPACED_COMMENT_RE)) {
		const prefix = match[1];
		if (prefix === undefined) continue;
		if (prefix === 'annoteca') continue;
		const offset = match.index ?? 0;
		out.push({
			path,
			prefix,
			excerpt: content.slice(
				offset,
				Math.min(content.length, offset + 80),
			),
			offset,
		});
	}
	return out;
}

export interface OrphanFinding {
	path: string;
	comment: Comment;
}

// Heuristic: a comment is "orphaned" when its enclosing block has no prose
// surrounding it. Concretely: the marker is the only non-whitespace content
// on its line, AND the lines immediately above and below are also blank or
// missing. That state implies the prose the marker was attached to was
// deleted.
export function detectOrphans(content: string, path: string): OrphanFinding[] {
	const out: OrphanFinding[] = [];
	const comments = parseAll(content);
	for (const c of comments) {
		// F-272: an addressed comment is intentionally in a pending, "replaced"
		// state; its anchor may no longer match and it can sit on its own line.
		// That is expected, not an accidental orphan, so do not flag it.
		if (c.addressed) continue;
		if (isOrphan(content, c)) out.push({ path, comment: c });
	}
	return out;
}

function isOrphan(content: string, c: Comment): boolean {
	const beforeStart = findLineStart(content, c.marker.start);
	const afterEnd = findLineEnd(content, c.marker.end);

	const lineContent = content.slice(beforeStart, afterEnd);
	const markerPiece = content.slice(c.marker.start, c.marker.end);
	const lineWithoutMarker = lineContent.replace(markerPiece, '');
	if (lineWithoutMarker.trim() !== '') return false;

	const previousLineBlank =
		beforeStart === 0 || isBlankLine(content, beforeStart - 1);
	const nextLineBlank =
		afterEnd >= content.length || isBlankLine(content, afterEnd + 1);
	return previousLineBlank && nextLineBlank;
}

function findLineStart(content: string, offset: number): number {
	for (let i = offset; i > 0; i--) {
		if (content.charAt(i - 1) === '\n') return i;
	}
	return 0;
}

function findLineEnd(content: string, offset: number): number {
	for (let i = offset; i < content.length; i++) {
		if (content.charAt(i) === '\n') return i;
	}
	return content.length;
}

function isBlankLine(content: string, offsetInLine: number): boolean {
	const start = findLineStart(content, offsetInLine);
	const end = findLineEnd(content, offsetInLine);
	return content.slice(start, end).trim() === '';
}

export interface ValidationFinding extends MalformedMarker {
	path: string;
}

export function validateMarkers(
	content: string,
	path: string,
): ValidationFinding[] {
	return findMalformedMarkers(content).map((m) => ({ ...m, path }));
}

// Decides when marker damage is worth interrupting the user for.
//
// The diagnostic itself is old; what was missing is anyone asking it. Its only
// caller was a command, and a user who does not already suspect a problem has no
// reason to run one, so the failure it detects had to cost them a paragraph
// before anything mentioned it. Every index rebuild for a note the user is
// actually in now asks.
//
// The rules exist because a Notice on every rebuild would be noise, and noise
// gets dismissed unread:
//
//   1. ONCE PER NOTE PER SESSION. Rebuilds fire on open and on save, so a note
//      being worked in rebuilds repeatedly and the finding is the same finding
//      every time.
//   2. FORGOTTEN WHEN THE NOTE COMES BACK CLEAN. Fixing the marker clears the
//      path, so damage introduced later in the same session is announced again
//      rather than silently swallowed by rule 1.
//
// Returns the text to show, or undefined for "say nothing". Kept as a value
// rather than firing the Notice here so the decision is testable without
// Obsidian, which is the part with rules in it.
export class MarkerDamageReporter {
	private readonly warned = new Set<string>();

	report(
		path: string,
		displayName: string,
		findings: readonly MalformedMarker[],
	): string | undefined {
		const first = findings[0];
		if (first === undefined) {
			this.warned.delete(path);
			return undefined;
		}
		if (this.warned.has(path)) return undefined;
		this.warned.add(path);
		// The finding's own reason, not a second phrasing of it. The report note
		// and this notice describe the same problem, and two copies drift.
		const more =
			findings.length > 1
				? ` ${findings.length - 1} more like it in this note.`
				: '';
		return `Annoteca found a marker problem in ${displayName}. ${first.reason}${more} Run "Validate marker format" for the full list.`;
	}

	// A note that is gone cannot be warned about again, and holding its path
	// would make a later note at the same path silent.
	forget(path: string): void {
		this.warned.delete(path);
	}

	// A renamed note is the same note. Without this the user is warned about it
	// a second time under its new name, and the old path sits in the set for the
	// rest of the session keeping a genuinely new note at that path quiet.
	rename(oldPath: string, newPath: string): void {
		if (!this.warned.delete(oldPath)) return;
		this.warned.add(newPath);
	}
}
