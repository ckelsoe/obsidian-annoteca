// Diagnostics: marker conflict detector (F-232), orphan comment detector
// (F-233), and format validation (F-235). All pure over file content.

import type { Comment } from './types';
import { parseAll, findMalformedMarkers, type MalformedMarker } from './parser';
import { isLeanMarker, parseDocument } from './document';
import { parseStore } from './store';

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

// The prefix grammar, as a standalone predicate so the settings validator gates
// allowlist entries against the SAME shape the scan matches rather than a second
// hand-written copy. parser.ts carries a worked example of what a drifted second
// copy costs: OPENER_ANYWHERE_RE was hand-written, disagreed with MARKER_RE about
// whitespace before the colon, and went from a cosmetic gap to a real one the
// moment two consumers keyed on it. An allowlist entry the scan can never match
// is the same failure in miniature, silently doing nothing.
const NAMESPACE_PREFIX_RE = /^[a-z][a-z0-9-]*$/;

export function isNamespacePrefix(value: string): boolean {
	return NAMESPACE_PREFIX_RE.test(value);
}

// `allowlist` holds namespaces the user has declared known (F-285), and defaults
// to empty so every existing caller and test keeps today's behaviour. Annoteca's
// own prefix is skipped unconditionally and is not an allowlist entry: it is not
// a foreign namespace the user could choose to hear about.
export function detectMarkerConflicts(
	content: string,
	path: string,
	allowlist: readonly string[] = [],
): ConflictFinding[] {
	const allowed = new Set(allowlist);
	const out: ConflictFinding[] = [];
	for (const match of content.matchAll(NAMESPACED_COMMENT_RE)) {
		const prefix = match[1];
		if (prefix === undefined) continue;
		if (prefix === 'annoteca') continue;
		if (allowed.has(prefix)) continue;
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

// The two eof-mode orphan directions (issue #48). Both break the marker/store
// join that keeps a "keep prose clean" comment whole:
//   - orphaned-store-entry: a store entry no lean marker points at. The passage
//     and its marker were deleted but the entry was left behind, so its body,
//     thread and history sit at the end of the file with nothing to show them.
//   - dangling-lean-marker: a lean category+id marker with no store entry to join.
//     The entry was deleted (or never written), so the marker renders as an empty
//     comment with nothing behind it.
export interface StoreOrphanFinding {
	path: string;
	kind: 'orphaned-store-entry' | 'dangling-lean-marker';
	id: string;
	category: string;
	// The stored body for an orphaned entry, so the user can recognize which
	// comment it was; empty for a dangling marker, whose body is gone.
	body: string;
}

// Find both eof-mode orphan directions in one pass. Inline-only files produce
// nothing: they have no store entries to strand, and their markers are not lean.
export function detectStoreOrphans(
	content: string,
	path: string,
): StoreOrphanFinding[] {
	const out: StoreOrphanFinding[] = [];

	// Orphaned store entries: parseDocument already computes which entries no lean
	// marker consumed.
	for (const entry of parseDocument(content).orphanedStore) {
		out.push({
			path,
			kind: 'orphaned-store-entry',
			id: entry.comment.id,
			category: entry.comment.category,
			body: entry.comment.body,
		});
	}

	// Dangling lean markers: a lean marker whose id joins no store entry. A marker
	// that still carries inline content is a normal inline comment, not dangling.
	const storeIds = new Set(parseStore(content).map((e) => e.comment.id));
	for (const marker of parseAll(content)) {
		if (marker.id === undefined) continue;
		if (!isLeanMarker(marker)) continue;
		if (storeIds.has(marker.id)) continue;
		out.push({
			path,
			kind: 'dangling-lean-marker',
			id: marker.id,
			category: marker.category,
			body: '',
		});
	}

	return out;
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
