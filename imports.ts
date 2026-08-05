// Import helpers (F-221, F-222, F-230). Pure conversion utilities; commands
// in main.ts wrap these with backup-confirmation modals and bulk vault writes.

import { scanMarkers, serialize } from './parser';

// Match `%%text%%` Obsidian native comments. Non-greedy, multiline.
const NATIVE_COMMENT_RE = /%%([\s\S]*?)%%/g;

// Match `<!-- text -->` HTML comments. Non-greedy, multiline.
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;

// A fenced code block opener or closer, per CommonMark: up to three spaces of
// indent, then a run of at least three backticks or tildes. Group 3 is the rest
// of the line, which must be blank for the line to CLOSE a block.
//
// The blockquote prefix is allowed because a fence inside a block quote is
// ordinary CommonMark, and quoting documentation is exactly the case where a
// note holds comment syntax it does not want converted. Tracking quote nesting
// properly is more than this needs: treating a quoted fence as a fence can only
// ever protect MORE text than a renderer would, and over-protecting during a
// bulk rewrite means "left something alone", which is the recoverable direction.
const FENCE_LINE_RE = /^((?:\s{0,3}>)*\s{0,3})(`{3,}|~{3,})(.*)$/;

// Inline code spans in a stretch of text, as offsets relative to it. Applied
// outside fenced blocks, over a whole run of consecutive lines rather than one
// line at a time: a code span is inline content and CommonMark lets one run
// across line breaks, so a per-line matcher saw two unmatched backticks instead
// of one span and left the text between them unprotected.
//
// CommonMark's rule exactly: a backtick RUN opens a span, the closer is the
// next run of the SAME length, and an opener with no such run is literal text
// with scanning resuming after it. Both ends being complete runs is the part
// that matters, and the part a regex got wrong: `` `+ `` could backtrack into
// the middle of a ``` and pair one of its backticks with a lone one further
// along, which is not a span any renderer sees. Found by running this scanner
// and the one it replaces over 1,946 real notes; the one file where the two
// disagreed disagreed over exactly that, and BOTH readings were wrong.
//
// Written as a scan rather than a regex because the fix for that was `(?<!`)`,
// and lookbehind is a PARSE error in JavaScriptCore before iOS 16.4. This
// plugin is not desktop-only and esbuild targets es2018, so the pattern shipped
// verbatim: every affected phone would have failed to load the plugin at all,
// not merely mis-scanned a note. A scan also drops the backtracking, so it is
// linear in the text.
function codeSpans(text: string): ProtectedRange[] {
	const spans: ProtectedRange[] = [];
	const runEnd = (at: number): number => {
		let i = at;
		while (i < text.length && text.charAt(i) === '`') i++;
		return i;
	};
	let i = 0;
	while (i < text.length) {
		if (text.charAt(i) !== '`') {
			i++;
			continue;
		}
		const openEnd = runEnd(i);
		const length = openEnd - i;
		let closeAt = -1;
		let j = openEnd;
		while (j < text.length) {
			if (text.charAt(j) !== '`') {
				j++;
				continue;
			}
			const end = runEnd(j);
			if (end - j === length) {
				closeAt = j;
				break;
			}
			j = end;
		}
		if (closeAt === -1) {
			// No matching run: the opener is literal, and scanning carries on
			// after it rather than trying a shorter one.
			i = openEnd;
			continue;
		}
		spans.push({ from: i, to: closeAt + length });
		i = closeAt + length;
	}
	return spans;
}

// A code span is inline content of ONE block, so a run must stop wherever a new
// block begins. These are the CommonMark line shapes that end the block above
// them, split by what the block they open can hold.
//
// Both directions cost something, so neither is a free default. A run that
// reaches PAST a boundary pairs backticks belonging to different blocks and
// marks the prose between them protected, and bulk import then converts nothing
// and reports it as "no comments found". A run that stops too EARLY splits a
// real code span, and import rewrites the sample inside it. So these follow
// CommonMark rather than a safety preference, and where they cannot, they say so.

// One line IS the whole block: a heading's text cannot continue below it, and a
// thematic break or setext underline has no inline content at all.
const SELF_CONTAINED_BLOCK_RE =
	/^ {0,3}(?:#{1,6}(?:\s|$)|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$|=+\s*$|-+\s*$)/;

// Opens or continues a block quote. Consecutive quote lines are ONE run, since
// they are one block: an Obsidian callout is a block quote, and a code span
// wrapped across two of its lines is a shape that turns up in real notes.
const BLOCK_OPENER_RE = /^ {0,3}>/;

// A pipe table row. Each cell parses its inline content separately, so a run
// must not carry a backtick from one row into another.
//
// Only the leading-pipe form is recognised, which is what Obsidian writes and
// what its table editor produces. A table written without leading pipes reads
// as ordinary paragraph lines here, which leaves its rows in one run: the cost
// is over-protection, so a comment inside such a table may be left alone by
// import rather than a sample being rewritten.
const TABLE_ROW_RE = /^ {0,3}\|/;

// Opens an HTML block (type 2), which is what a generic `<!-- ... -->` the
// import pass is about to convert looks like. It is one block, running to the
// line that carries `-->`, so no run may span it. Its lines are still scanned
// individually: a renderer sees raw HTML with no code spans in it, but the
// native pass converts a `%%...%%` wherever it sits, and a marker written
// inside this comment would close it early with its own `-->`.
//
// The OTHER HTML block types are knowingly not modelled. A `<script>` or a
// `<div>` between two unmatched backticks leaves the run open across it, so a
// `%%comment%%` in between reads as code and import skips it. Recognising them
// means the type 1 and type 6 tag lists plus their separate end conditions, and
// type 7 must NOT break a run because it cannot interrupt a paragraph, so a
// crude "line starts with a tag" rule would be wrong in the direction that
// rewrites a code sample. The comment type is here because the import pass
// converts exactly that shape, so it is the one that actually comes up.
const HTML_COMMENT_OPEN_RE = /^ {0,3}<!--/;

// Any list item marker at the document margin.
const LIST_ITEM_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

// The same, at any indentation. Only consulted when a list is already open,
// where an indented marker is a NESTED item rather than continuation text, and
// so ends the item above it. Without this a nested item joined its parent's run
// and their backticks paired across two blocks.
//
// Indentation still has a ceiling, just a relative one: four columns past where
// the open item's content starts makes the line indented code inside that item,
// which cannot interrupt its paragraph. `contentIndent` on the run is what that
// is measured against. Counted in characters, so a tab counts as one rather
// than as CommonMark's four; a tab-indented nested list is the case that costs,
// and it costs over-protection.
const NESTED_LIST_ITEM_RE = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

// Where an item's content begins: past the indent, the marker, and the spaces
// after it. A marker with no space after it (`-` alone) still opens content one
// column along, which is what the `|| 1` covers.
const LIST_MARKER_RE = /^([ \t]*)((?:[-+*]|\d{1,9}[.)]))([ \t]*)/;

function listContentIndent(line: string): number {
	const m = LIST_MARKER_RE.exec(line);
	if (!m) return 0;
	return (
		(m[1]?.length ?? 0) + (m[2]?.length ?? 0) + ((m[3]?.length ?? 0) || 1)
	);
}

function leadingIndent(line: string): number {
	return line.length - line.trimStart().length;
}

// The subset that can INTERRUPT an open paragraph: non-empty, and, when ordered,
// numbered 1. `2. still code` in the middle of a paragraph is ordinary text, so
// treating every ordered marker as a boundary split real code spans and let
// import rewrite what was inside them.
//
// With NO paragraph open there is nothing to interrupt, so any marker starts an
// item, and from then on the run remembers it is one. That is what makes a list
// numbered from 2 behave like a list rather than like one long paragraph.
const INTERRUPTING_ITEM_RE = /^ {0,3}(?:[-+*]|1[.)])[ \t]+\S/;

// Four spaces or a tab, which opens an indented code block when no paragraph is
// open. It cannot interrupt one, so this is only consulted when there is no run
// in progress; a deeply indented continuation line stays with its paragraph.
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

export interface ImportResult {
	updated: string;
	converted: number;
}

interface ProtectedRange {
	from: number;
	to: number;
}

// Regions a bulk conversion must not rewrite, as absolute offsets into
// `content`.
//
// Three sources, and all three are executed failures rather than hypotheticals:
//
//   1. EXISTING ANNOTECA MARKERS. A `%%...%%` inside a marker's body was
//      converted in place, which nests a marker inside a marker: MARKER_RE stops
//      at the inner `-->`, and the rest of the outer marker spills into the
//      document as visible prose. Only the HTML pass had a skip predicate, and
//      "Import all" runs the native pass first, so it hit every time.
//   2. FENCED CODE BLOCKS. A note documenting comment syntax had its own
//      examples converted, destroying the sample, and the notice counted them
//      as successes.
//   3. INLINE CODE SPANS. Same failure at a smaller scale.
//
// A mask rather than a per-pattern predicate, because the predicate only ever
// saw the matched TEXT and this question is about the match's POSITION.
function protectedRanges(content: string): ProtectedRange[] {
	const markers = scanMarkers(content);
	const out: ProtectedRange[] = [];
	for (const m of markers) out.push({ from: m.start, to: m.end });

	// A marker's interior is OPAQUE to the fence and code-span scanners.
	//
	// Marker bodies are arbitrary user text, and the format stores the
	// annoteca-original block as a literal fence, so ``` lines inside a marker
	// are ordinary rather than exotic. Reading them as document structure let a
	// body with a single unbalanced fence line open a block that never closed,
	// which marked the entire rest of the file protected: bulk import then
	// silently converted nothing after that marker and reported "converted 0",
	// which reads as "there was nothing to convert."
	//
	// Skipping them costs nothing, because every marker span is already in `out`
	// on its own account. The test for this is the same question the parser's
	// own fence rule turns on: what can a body CONTAIN?
	let markerAt = 0;
	const insideMarker = (lineStart: number): boolean => {
		while (
			markerAt < markers.length &&
			(markers[markerAt]?.end ?? 0) <= lineStart
		)
			markerAt++;
		const m = markers[markerAt];
		return m !== undefined && lineStart >= m.start && lineStart < m.end;
	};

	// The run of consecutive lines a single code span is allowed to cover, as
	// absolute offsets. A span is inline content, so it cannot cross anything
	// that ends the surrounding block: a blank line, a fence line, a marker, or
	// any of the block starts above. Bounding it that way is what keeps the
	// multi-line matcher from pairing a stray backtick in one paragraph with a
	// stray backtick in another and declaring everything between them code.
	//
	// `kind` and `contentIndent` are the block context this needs. `kind` says
	// whether a `>` below the run continues the same quote and whether a `2.`
	// below it is a new item or ordinary paragraph text; `contentIndent` says how
	// far a nested marker may be indented before it stops being an item.
	interface TextRun {
		from: number;
		to: number;
		kind: 'text' | 'listItem' | 'quote';
		contentIndent: number;
	}
	let textRun: TextRun | undefined;

	// Scan one stretch of ordinary text for code spans and record them.
	const scanSegment = (from: number, to: number): void => {
		if (to <= from) return;
		for (const span of codeSpans(content.slice(from, to))) {
			out.push({ from: from + span.from, to: from + span.to });
		}
	};

	const flushRun = (): void => {
		const region = textRun;
		textRun = undefined;
		if (region === undefined) return;
		// Scan the GAPS between markers, never across one.
		//
		// The line-start test above cannot carry this on its own, because the
		// plugin writes a marker INLINE: comment-service splices the marker and
		// the prose it annotates into the same line, which is the shape of this
		// repo's own fixtures. Such a line begins outside the marker, so it
		// joins the run, and a lone backtick in the marker's BODY then pairs
		// with one out in the prose. Both directions were reproduced through
		// the real "Import all" entry point: a `%%sample%%` inside a genuine
		// code span got rewritten, and elsewhere a real comment was marked
		// protected and silently skipped.
		//
		// A marker's body is arbitrary user text, not inline content of the
		// document, which is the same reason the fence scanner already treats
		// marker interiors as opaque. Splitting also means the text after a
		// marker's closing `-->` on the same line is scanned, which the
		// line-at-a-time scanner never did either.
		let at = region.from;
		for (const m of markers) {
			if (m.end <= at) continue;
			if (m.start >= region.to) break;
			scanSegment(at, Math.min(m.start, region.to));
			at = Math.max(at, m.end);
		}
		scanSegment(at, region.to);
	};

	let offset = 0;
	let openFence: { char: string; length: number; from: number } | undefined;
	let inHtmlComment = false;
	for (const line of content.split('\n')) {
		const lineEnd = offset + line.length;
		if (insideMarker(offset)) {
			// Neither opens nor closes a fence, and contributes no code spans. A
			// fence opened OUTSIDE a marker stays open across it, which is what
			// a renderer does too.
			flushRun();
			// It DOES close a generic HTML comment opened above it, though. An
			// HTML block ends on the first line carrying `-->`, and a marker's
			// own terminator is such a line. Without this the comment state
			// outlived the comment, because this branch consumes marker lines
			// before the in-comment branch below can see them, and every run
			// after it was cut to one line.
			if (inHtmlComment && line.includes('-->')) inHtmlComment = false;
			offset = lineEnd + 1;
			continue;
		}
		if (inHtmlComment) {
			// Inside a generic HTML comment. It is one block, so no run may span
			// it, and it ends on the line carrying the closing delimiter.
			//
			// Each line is still scanned on its own, rather than skipped. A
			// renderer sees raw HTML here and no code spans at all, but the
			// native pass converts `%%...%%` wherever it finds one, including
			// inside this comment, and a marker written in there closes the
			// outer comment early with its own `-->`. A `` `%%example%%` `` in a
			// comment was protected from that by the per-line scanner this
			// replaced, and dropping the scan would have handed it back.
			textRun = {
				from: offset,
				to: lineEnd,
				kind: 'text',
				contentIndent: 0,
			};
			flushRun();
			if (line.includes('-->')) inHtmlComment = false;
			offset = lineEnd + 1;
			continue;
		}
		const fence = FENCE_LINE_RE.exec(line);
		const fenceRun = fence?.[2];
		if (openFence !== undefined) {
			// A closing fence is the same character, at least as long, with
			// nothing after it.
			if (
				fenceRun !== undefined &&
				fenceRun.charAt(0) === openFence.char &&
				fenceRun.length >= openFence.length &&
				(fence?.[3] ?? '').trim() === ''
			) {
				out.push({ from: openFence.from, to: lineEnd });
				openFence = undefined;
			}
		} else if (fenceRun !== undefined) {
			flushRun();
			openFence = {
				char: fenceRun.charAt(0),
				length: fenceRun.length,
				from: offset,
			};
		} else if (line.trim() === '') {
			flushRun();
		} else if (
			SELF_CONTAINED_BLOCK_RE.test(line) ||
			TABLE_ROW_RE.test(line)
		) {
			// Scanned on its own, not skipped: a heading's text and a table cell
			// can hold a code span like any other inline content, and dropping
			// them would leave less protected than the per-line scanner this
			// replaced.
			flushRun();
			textRun = {
				from: offset,
				to: lineEnd,
				kind: 'text',
				contentIndent: 0,
			};
			flushRun();
		} else if (
			INTERRUPTING_ITEM_RE.test(line) ||
			(textRun === undefined && LIST_ITEM_RE.test(line)) ||
			(textRun?.kind === 'listItem' &&
				NESTED_LIST_ITEM_RE.test(line) &&
				leadingIndent(line) < textRun.contentIndent + 4)
		) {
			flushRun();
			textRun = {
				from: offset,
				to: lineEnd,
				kind: 'listItem',
				contentIndent: listContentIndent(line),
			};
		} else if (HTML_COMMENT_OPEN_RE.test(line)) {
			// One block, so the run stops on both sides of it, and this line is
			// scanned on its own like every other line of the comment.
			flushRun();
			textRun = {
				from: offset,
				to: lineEnd,
				kind: 'text',
				contentIndent: 0,
			};
			flushRun();
			// An opener with no `-->` anywhere below it is a typo rather than a
			// block. Reading it as one would put the rest of the file inside a
			// comment and stop every run there.
			if (!line.includes('-->'))
				inHtmlComment = content.indexOf('-->', lineEnd) !== -1;
		} else if (BLOCK_OPENER_RE.test(line)) {
			// A quote already in progress carries on: consecutive `>` lines are
			// one block, so a span may run across them.
			if (textRun?.kind === 'quote') {
				textRun = { ...textRun, to: lineEnd };
			} else {
				flushRun();
				textRun = {
					from: offset,
					to: lineEnd,
					kind: 'quote',
					contentIndent: 0,
				};
			}
		} else if (textRun === undefined && INDENTED_CODE_RE.test(line)) {
			// Opens an indented code block, so it is not the first line of the
			// paragraph below it. Scanned alone rather than skipped, which keeps
			// the per-line behaviour this replaced; protecting indented code
			// wholesale is a separate change from bounding the runs.
			textRun = {
				from: offset,
				to: lineEnd,
				kind: 'text',
				contentIndent: 0,
			};
			flushRun();
		} else {
			textRun =
				textRun === undefined
					? {
							from: offset,
							to: lineEnd,
							kind: 'text',
							contentIndent: 0,
						}
					: { ...textRun, to: lineEnd };
		}
		offset = lineEnd + 1;
	}
	flushRun();
	// An unclosed fence protects through end of file, which is also how a
	// markdown renderer reads it.
	if (openFence !== undefined)
		out.push({ from: openFence.from, to: content.length });

	return out;
}

function intersectsProtected(
	ranges: readonly ProtectedRange[],
	from: number,
	to: number,
): boolean {
	return ranges.some((r) => from < r.to && r.from < to);
}

// Shared replacement engine for both comment syntaxes. The regex picks the
// source format; `skip` lets a format leave specific matches untouched (the
// HTML pass must not re-convert markers already in the annoteca format).
function convertComments(
	content: string,
	category: string,
	pattern: RegExp,
	skip?: (body: string) => boolean,
): ImportResult {
	const ranges = protectedRanges(content);
	let converted = 0;
	const updated = content.replace(
		pattern,
		(full: string, body: string, offset: number) => {
			if (skip?.(body)) return full;
			if (intersectsProtected(ranges, offset, offset + full.length))
				return full;
			converted += 1;
			const cleaned = body.trim().replace(/\n+/g, ' ');
			// Through serialize() rather than interpolated, so imported text
			// gets the same `-->` escaping every other write path uses. A
			// `%%...%%` native comment CAN contain `-->` (only `%%` closes it),
			// and pasting that straight into an HTML comment ended the marker
			// early and spilled the rest of the comment into the document as
			// visible text.
			return serialize({ category, body: cleaned });
		},
	);
	return { updated, converted };
}

export function convertNativeComments(
	content: string,
	category: string,
): ImportResult {
	// No skip predicate: the mask covers this pass now. A predicate could not
	// have covered it anyway, because a `%%...%%` inside a marker looks exactly
	// like one outside it.
	return convertComments(content, category, NATIVE_COMMENT_RE);
}

export function convertGenericHtmlComments(
	content: string,
	category: string,
): ImportResult {
	// Skip markers that already follow the annoteca format.
	return convertComments(content, category, HTML_COMMENT_RE, (body) =>
		/^\s*annoteca\//.test(body),
	);
}

export type ImportFormat = 'native' | 'html' | 'all';

export function convertAllComments(
	content: string,
	format: ImportFormat,
	category: string,
): ImportResult {
	if (format === 'native') return convertNativeComments(content, category);
	if (format === 'html') return convertGenericHtmlComments(content, category);
	const first = convertNativeComments(content, category);
	const second = convertGenericHtmlComments(first.updated, category);
	return {
		updated: second.updated,
		converted: first.converted + second.converted,
	};
}
