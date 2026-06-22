// Pure helpers used by the hub panel views. No Obsidian dependency so
// they can be unit-tested without mocking the runtime API.

import type { AuthorStyle, Comment } from "./types";

// Per-author color lookup (F-275). Returns the configured color for an author
// tag, or undefined when the author has no style. Case-sensitive: author tags
// are stored verbatim (the parser preserves casing).
export function authorColorFor(tag: string, styles: AuthorStyle[]): string | undefined {
	return styles.find(s => s.tag === tag)?.color;
}

// Format an Annoteca timestamp for display in the panel and hover popups. A
// full timestamp (YYYY-MM-DDTHH:MM:SS) renders as "YYYY-MM-DD HH:MM:SS" with the
// "T" swapped for a space; the seconds are kept because disambiguating fast
// same-second replies is the whole point of the timestamp. A legacy date-only
// stamp (YYYY-MM-DD) renders unchanged. Input is trusted parser output, so this
// only swaps the separator rather than validating.
export function formatStamp(iso: string): string {
	return iso.replace("T", " ");
}

// Truncate text to `max` characters, appending a single ellipsis when cut. The
// limit is contextual (a compact list row shows less than a card), so callers
// pass their own; this just removes the three-copy `length > n ? slice : text`
// idiom that drifted to different limits across the panels.
export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + "…" : text;
}

// Build the author picker options for the reply composer (F-274). Combines, in
// order and deduped: the configured global author tag, the configured
// collaborator/author-style tags, and the authors already present in the thread
// (so you can reply as anyone who has spoken). Empty/blank tags are dropped.
export function authorPickerOptions(
	globalTag: string | undefined,
	styles: AuthorStyle[],
	threadAuthors: string[],
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (tag: string | undefined): void => {
		const t = (tag ?? "").trim();
		if (t === "" || seen.has(t)) return;
		seen.add(t);
		out.push(t);
	};
	add(globalTag);
	for (const s of styles) add(s.tag);
	for (const a of threadAuthors) add(a);
	return out;
}

// Decide whether a keydown in a comment composer (new-comment box or reply box)
// should submit. When submitOnEnter is true, Enter submits and Shift+Enter
// inserts a newline; when false, Cmd/Ctrl+Enter submits and plain Enter inserts
// a newline. Pure so the rule is unit-tested once and shared by both composers.
export function shouldSubmitOnKeydown(
	e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
	submitOnEnter: boolean,
): boolean {
	if (e.key !== "Enter") return false;
	return submitOnEnter ? !e.shiftKey : (e.ctrlKey || e.metaKey);
}

export type ScrollAction = "center" | "minimal" | "none";

// Decide how to scroll the editor when navigating to a comment (F-276).
//
// When the user opts into centering, always center. Otherwise scroll the
// minimum needed to bring the target into view, and do nothing at all when the
// target is already visible. The "none" case is the whole point: clicking a
// comment in the side panel, or selecting a marker whose text is already on
// screen, must not yank the document under the reader.
export function decideScrollAction(
	centerOnNavigate: boolean,
	targetVisible: boolean,
): ScrollAction {
	if (centerOnNavigate) return "center";
	return targetVisible ? "none" : "minimal";
}

// Window size searched on each side of a marker for its anchor text. Bounds the
// look-around to the longest legal anchor (80 chars) plus slack. Mirrors the
// historical 200-char look-back window.
export const ANCHOR_WINDOW = 200;

export interface AnchorMatch { from: number; to: number; }

// Direction-agnostic anchor resolver (F-273). Locate the document range that
// matches a comment's stored anchor text, searching BOTH the window before the
// marker (legacy end-placement, matched backward) and the window after it
// (begin-placement, matched forward). Returns the absolute {from,to} of the
// matched prose, or null when neither side matches (the underline then degrades
// silently, per the data-format contract).
//
// Pure over plain strings so it is unit-testable without a CodeMirror view.
// `precedingWindow` is doc[backStart, markerStart]; `followingWindow` is
// doc[markerEnd, ...]. A single optional space between the marker and the anchor
// (introduced by the composer) is tolerated on whichever side matches and is
// excluded from the returned range. Backward is tried first so a legacy
// end-placed marker resolves identically to before.
export function resolveAnchorRangeInWindows(
	precedingWindow: string,
	backStart: number,
	markerStart: number,
	followingWindow: string,
	markerEnd: number,
	anchorText: string,
): AnchorMatch | null {
	if (anchorText.length === 0) return null;
	const back = precedingWindow;
	const fwd = followingWindow;
	const ellipsisIdx = anchorText.indexOf("…");

	if (ellipsisIdx === -1) {
		// Non-truncated: the anchor sits flush against the marker, possibly with
		// one composer-introduced space between them.
		if (back.endsWith(anchorText)) {
			return { from: markerStart - anchorText.length, to: markerStart };
		}
		if (back.endsWith(anchorText + " ")) {
			return { from: markerStart - anchorText.length - 1, to: markerStart - 1 };
		}
		if (fwd.startsWith(anchorText)) {
			return { from: markerEnd, to: markerEnd + anchorText.length };
		}
		if (fwd.startsWith(" " + anchorText)) {
			return { from: markerEnd + 1, to: markerEnd + 1 + anchorText.length };
		}
		return null;
	}

	// Truncated head…tail. Match symmetrically:
	//  - backward: tail flush to the marker, head somewhere earlier;
	//  - forward:  head flush to the marker, tail somewhere later.
	const head = anchorText.slice(0, ellipsisIdx);
	const tail = anchorText.slice(ellipsisIdx + 1);
	if (head.length === 0 || tail.length === 0) return null;

	// Backward.
	let tailEnd: number | null = null;
	if (back.endsWith(tail)) tailEnd = markerStart;
	else if (back.endsWith(tail + " ")) tailEnd = markerStart - 1;
	if (tailEnd !== null) {
		const tailStart = tailEnd - tail.length;
		const headHaystack = back.slice(0, tailStart - backStart);
		const headIdxLocal = headHaystack.lastIndexOf(head);
		if (headIdxLocal !== -1) {
			return { from: backStart + headIdxLocal, to: tailEnd };
		}
	}

	// Forward.
	let headStart: number | null = null;
	if (fwd.startsWith(head)) headStart = markerEnd;
	else if (fwd.startsWith(" " + head)) headStart = markerEnd + 1;
	if (headStart !== null) {
		const afterHeadLocal = (headStart - markerEnd) + head.length;
		const tailHaystack = fwd.slice(afterHeadLocal);
		const tailIdxLocal = tailHaystack.indexOf(tail);
		if (tailIdxLocal !== -1) {
			const to = markerEnd + afterHeadLocal + tailIdxLocal + tail.length;
			return { from: headStart, to };
		}
	}

	return null;
}

// String convenience wrapper over resolveAnchorRangeInWindows: slices the
// before/after windows from a full document string. Used by tests; the editor
// path in decorations.ts slices CM windows directly to avoid materializing the
// whole document per marker.
export function resolveAnchorRange(
	doc: string,
	markerStart: number,
	markerEnd: number,
	anchorText: string,
): AnchorMatch | null {
	const backStart = Math.max(0, markerStart - ANCHOR_WINDOW);
	const preceding = doc.slice(backStart, markerStart);
	const following = doc.slice(markerEnd, Math.min(doc.length, markerEnd + ANCHOR_WINDOW));
	return resolveAnchorRangeInWindows(preceding, backStart, markerStart, following, markerEnd, anchorText);
}

// Decoration spec for the active-comment highlight (F-276). Pure data so the
// planner can be unit-tested without a CodeMirror view.
export interface ActiveDecoSpec { from: number; to: number; cls: string; }

export const ACTIVE_COMMENT_CLASS = "annoteca-active-comment";
export const ACTIVE_COMMENT_MARKER_CLASS = "annoteca-active-comment-marker";

// Pure planner for the active-comment decorations (F-276). Given the active
// marker start, the parsed markers, the resolved anchor range (or null), and
// the hide-all flag, return the decoration specs in monotonic start order.
// Returns [] when nothing should be highlighted: no selection (null), the
// marker is gone, or comments are hidden. Separated from the CodeMirror facet
// in decorations.ts so the set/clear behavior is unit-testable headlessly.
export function planActiveCommentDecorations(
	activeStart: number | null,
	markers: Comment[],
	anchorRange: { from: number; to: number } | null,
	hideAll: boolean,
): ActiveDecoSpec[] {
	if (hideAll || activeStart === null) return [];
	const m = markers.find(c => c.marker.start === activeStart);
	if (!m) return [];

	const specs: ActiveDecoSpec[] = [];
	// Highlight the anchored text when it resolves on either side of the marker.
	// This is the reader-facing "this is the passage" cue.
	if (anchorRange && anchorRange.from < anchorRange.to) {
		specs.push({ from: anchorRange.from, to: anchorRange.to, cls: ACTIVE_COMMENT_CLASS });
	}
	// Always accent the marker itself so a comment with no anchor (or whose
	// anchor no longer matches) still shows which marker is active.
	specs.push({ from: m.marker.start, to: m.marker.end, cls: ACTIVE_COMMENT_MARKER_CLASS });
	// RangeSet requires monotonically increasing start offsets. The anchor can
	// sit before or after the marker (direction-agnostic), so sort.
	specs.sort((a, b) => a.from - b.from);
	return specs;
}

export function extractIndexTerm(body: string): string {
	// The modal template emits `<term> > <subterm> — <body>` or `<term> — <body>`.
	// Strip the post-em-dash body if present; return the term/subterm chain.
	const dashIdx = body.indexOf(" — ");
	const head = dashIdx === -1 ? body : body.slice(0, dashIdx);
	return head.trim() || "(unspecified)";
}

export interface HeadingBucket { open: number; resolved: number; }

export interface HeadingShape {
	heading: string;
	level: number;
	position: { start: { offset: number } };
}

export function bucketCommentsByHeading(
	headings: HeadingShape[],
	comments: Comment[],
): HeadingBucket[] {
	const buckets: HeadingBucket[] = headings.map(() => ({ open: 0, resolved: 0 }));
	for (const c of comments) {
		let bucketIdx = -1;
		for (let i = 0; i < headings.length; i++) {
			const h = headings[i];
			if (!h) continue;
			if (h.position.start.offset > c.marker.start) break;
			bucketIdx = i;
		}
		if (bucketIdx === -1) continue;
		const bucket = buckets[bucketIdx];
		if (!bucket) continue;
		if (c.resolution) bucket.resolved += 1;
		else bucket.open += 1;
	}
	return buckets;
}
