// Diagnostics: marker conflict detector (F-232), orphan comment detector
// (F-233), and format validation (F-235). All pure over file content.

import type { Comment } from "./types";
import { parseAll, findMalformedMarkers, type MalformedMarker } from "./parser";

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

export function detectMarkerConflicts(content: string, path: string): ConflictFinding[] {
	const out: ConflictFinding[] = [];
	for (const match of content.matchAll(NAMESPACED_COMMENT_RE)) {
		const prefix = match[1];
		if (prefix === undefined) continue;
		if (prefix === "annoteca") continue;
		const offset = match.index ?? 0;
		out.push({
			path,
			prefix,
			excerpt: content.slice(offset, Math.min(content.length, offset + 80)),
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
		if (isOrphan(content, c)) out.push({ path, comment: c });
	}
	return out;
}

function isOrphan(content: string, c: Comment): boolean {
	const beforeStart = findLineStart(content, c.marker.start);
	const afterEnd = findLineEnd(content, c.marker.end);

	const lineContent = content.slice(beforeStart, afterEnd);
	const markerPiece = content.slice(c.marker.start, c.marker.end);
	const lineWithoutMarker = lineContent.replace(markerPiece, "");
	if (lineWithoutMarker.trim() !== "") return false;

	const previousLineBlank = beforeStart === 0 || isBlankLine(content, beforeStart - 1);
	const nextLineBlank = afterEnd >= content.length || isBlankLine(content, afterEnd + 1);
	return previousLineBlank && nextLineBlank;
}

function findLineStart(content: string, offset: number): number {
	for (let i = offset; i > 0; i--) {
		if (content.charAt(i - 1) === "\n") return i;
	}
	return 0;
}

function findLineEnd(content: string, offset: number): number {
	for (let i = offset; i < content.length; i++) {
		if (content.charAt(i) === "\n") return i;
	}
	return content.length;
}

function isBlankLine(content: string, offsetInLine: number): boolean {
	const start = findLineStart(content, offsetInLine);
	const end = findLineEnd(content, offsetInLine);
	return content.slice(start, end).trim() === "";
}

export interface ValidationFinding extends MalformedMarker {
	path: string;
}

export function validateMarkers(content: string, path: string): ValidationFinding[] {
	return findMalformedMarkers(content).map(m => ({ ...m, path }));
}
