// Import helpers (F-221, F-222, F-230). Pure conversion utilities; commands
// in main.ts wrap these with backup-confirmation modals and bulk vault writes.

import { scanMarkers, serialize } from './parser';

// Match `%%text%%` Obsidian native comments. Non-greedy, multiline.
const NATIVE_COMMENT_RE = /%%([\s\S]*?)%%/g;

// Match `<!-- text -->` HTML comments. Non-greedy, multiline.
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;

// A fenced code block opener or closer, per CommonMark: some indent, then a run
// of at least three backticks or tildes. Group 1 is the indent, group 2 the
// fence run, group 3 the rest of the line, which must be blank for the line to
// CLOSE a block.
//
// Matched against a line's CONTENT, after any block-quote markers have been
// stripped, so it carries no quote prefix of its own. The indent is captured
// rather than capped because the cap is RELATIVE: CommonMark allows a fence up
// to three columns past where its containing block's content starts, and this
// pattern used to write that as an absolute /\s{0,3}/, so a fence legally
// nested in a list item at four or more columns was not recognised as a fence
// at all and bulk convert rewrote the samples inside it.
const FENCE_LINE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

// The block-quote markers opening a line, each with the one space of content it
// is allowed to swallow. What follows is the quote's CONTENT, and every indent
// rule here is measured from where that starts.
//
// Stripping the markers first is what makes those rules work the same inside a
// quote as outside one. Measuring a quoted line from column zero instead
// charged the fence for indentation the markers had already consumed, and
// ignoring the indent entirely went the other way and read an over-indented
// literal `~~~` in a quote as an opener, protecting the ordinary quoted prose
// under it. Both were executed regressions against the reference CommonMark
// implementation before this became a strip-then-measure.
// Up to three SPACES of indent per marker, never a tab, which is the same rule
// `BLOCK_OPENER_RE` uses. A tab expands to four columns and so cannot open a
// quote, and letting one through here made the two disagree: `\t> text` counted
// as a quote continuation and held an open fence past the line that really ends
// it, so a genuine `> %%comment%%` below was protected and skipped.
const QUOTE_PREFIX_RE = /^(?: {0,3}>[ \t]?)+/;

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

// Leading indent in COLUMNS, with a tab advancing to the next multiple of four,
// which is how CommonMark measures indentation. `leadingIndent` counts
// CHARACTERS instead, and the two are deliberately not merged: the nested-item
// ceiling above is documented as character-counted (a tab-indented nested list
// costs over-protection there), while the fence and indented-code rules below
// decide whether a line is CODE, where reading a tab as one column would leave
// a tab-indented code sample unprotected and let bulk convert rewrite it.
function indentColumns(line: string): number {
	let col = 0;
	for (const ch of line) {
		if (ch === ' ' || ch === '\t') col = advanceColumns(ch, col);
		else break;
	}
	return col;
}

// Advance a column counter across `text`, a tab landing on the next multiple of
// four. Every column measurement in this file goes through it, so a tab cannot
// be worth four columns in one rule and one column in another: measuring a
// fence's indent in CHARACTERS while measuring the allowance it is compared
// against in columns read a tab-indented ``` at the margin as a fence opener,
// which never closed and protected the rest of the file, so every real comment
// below it was skipped and reported as "converted 0".
function advanceColumns(text: string, from: number): number {
	let col = from;
	for (const ch of text) col += ch === '\t' ? 4 - (col % 4) : 1;
	return col;
}

// Where an item's content begins, in columns. The column twin of
// `listContentIndent`, and what a fence or an indented-code line inside the item
// is measured against.
//
// Five or more COLUMNS of padding after the marker is CommonMark's
// indented-code case: the content starts one column past the marker and the
// rest is code. Without that clamp the allowance grows with the padding, and a
// deep fence far below could be read as an opener that never closes, which
// protects the rest of the file and reports "converted 0" as if there had been
// nothing to convert.
//
// Measured after expansion, not as `spaces.length`. `-\t\titem` is two padding
// CHARACTERS but seven columns, so a character count slips under the clamp and
// puts the item's content at column 8, which then reads an ordinary four-column
// paragraph below it as indented code and skips a real comment in it.
function listContentColumns(line: string): number {
	const m = LIST_MARKER_RE.exec(line);
	if (!m) return 0;
	const markerEnd = indentColumns(line) + (m[2]?.length ?? 0);
	const col = advanceColumns(m[3] ?? '', markerEnd);
	// A marker with no padding still opens content one column along.
	if (col - markerEnd === 0 || col - markerEnd >= 5) return markerEnd + 1;
	return col;
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

// Four columns past where the containing block's content starts, which opens an
// indented code block when no paragraph is open. It cannot interrupt one, so
// this is only consulted when there is no run in progress; a deeply indented
// continuation line stays with its paragraph.
//
// Relative, not absolute. Inside a list item whose content starts at column 2, a
// line at four columns is only two past the content and is ordinary paragraph
// text, so an absolute test would protect a real comment there and bulk convert
// would silently skip it. Outside any list `openItemIndent` is undefined and
// this is the plain four-columns-or-a-tab rule.
// Takes an indent already MEASURED in columns rather than a line, because the
// column a line's content starts at is not always zero: inside a block quote it
// starts after the markers, and a tab there lands on the next absolute tab stop,
// not four columns further on. Measuring `> \t%%comment%%` from zero made a
// two-column indent read as four and protected an ordinary quoted comment.
function opensIndentedCode(
	indentCols: number,
	blank: boolean,
	openItemIndent: number | undefined,
): boolean {
	if (blank) return false;
	return indentCols >= (openItemIndent ?? 0) + 4;
}

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

	// Monotonic cursor into `markers` for the walk in flushRun.
	let flushAt = 0;

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
		//
		// Walked from a monotonic cursor rather than from the start of `markers`
		// every time. Regions are flushed in increasing `from` order, so a marker
		// already behind one region can never matter to a later one; restarting
		// the walk made a note with many markers cost O(markers x flushes), and
		// flushRun runs about once per line.
		while (
			flushAt < markers.length &&
			(markers[flushAt]?.end ?? 0) <= region.from
		)
			flushAt++;
		let at = region.from;
		for (let i = flushAt; i < markers.length; i++) {
			const m = markers[i];
			if (m === undefined) continue;
			if (m.end <= at) continue;
			if (m.start >= region.to) break;
			scanSegment(at, Math.min(m.start, region.to));
			at = Math.max(at, m.end);
		}
		scanSegment(at, region.to);
	};

	let offset = 0;
	let openFence:
		| {
				char: string;
				length: number;
				from: number;
				itemDepth: number;
				quoteDepth: number;
		  }
		| undefined;
	let inHtmlComment = false;
	// Content indents, in columns, of the list items currently open, outermost
	// first. What the fence and indented-code rules are measured against, and it
	// deliberately SURVIVES a blank line: a blank line does not close a list
	// item, and the shape that started this was a fence one blank line under its
	// list item.
	//
	// A STACK rather than one value, because leaving a nested item returns to its
	// parent rather than to the document margin. Collapsing to "no list" instead
	// read the parent's own four-column paragraph as top-level indented code and
	// silently skipped a real comment in it.
	const openItems: number[] = [];
	const innerItem = (): number | undefined => openItems[openItems.length - 1];
	for (const line of content.split('\n')) {
		const lineEnd = offset + line.length;
		if (insideMarker(offset)) {
			// Neither opens nor closes a fence, and contributes no code spans. A
			// fence opened OUTSIDE a marker stays open across it, which is what
			// a renderer does too.
			flushRun();
			// A multi-line marker can END on this line, with ordinary prose
			// after its `-->`. That tail is inline content like any other, so
			// it starts a run the following lines may extend, or a code span
			// sitting against the terminator would go unprotected and bulk
			// convert would rewrite the sample inside it. flushRun's marker
			// walk keeps any further marker inside the tail opaque.
			//
			// NOT inside an open fence, though. There the tail is fence
			// content, protected by the fence itself when it closes, and the
			// fence branch below neither extends nor flushes a run, so one
			// seeded here would outlive the fence and pair its backticks with
			// the prose after it, falsely protecting a real comment.
			const covering = markers[markerAt];
			if (
				openFence === undefined &&
				covering !== undefined &&
				covering.end < lineEnd
			) {
				textRun = {
					from: covering.end,
					to: lineEnd,
					kind: 'text',
					contentIndent: 0,
				};
			}
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
		// Strip the quote markers, then measure everything from where the quote's
		// content starts. Outside a quote the prefix is empty and `body` is the
		// whole line, so the unquoted rules are untouched.
		const quotePrefix = QUOTE_PREFIX_RE.exec(line)?.[0] ?? '';
		const quoted = quotePrefix !== '';
		// How many quotes deep the line sits, not merely whether it is quoted.
		// A boolean cannot tell `> >` from `>`, so a fence opened in the inner
		// quote was treated as still open on a line belonging to the OUTER one
		// and was closed by it. With the depth, that line ends the inner fence
		// and then OPENS a new one in the outer quote, which is what a renderer
		// does: `> > ``` / > > code / > ``` / > %%sample%%` puts the sample in a
		// second, outer code block. Executed both ways round, the boolean
		// rewrote that sample and skipped a real comment in the other shape.
		const quoteDepth = (quotePrefix.match(/>/g) ?? []).length;
		const prefixCols = quoted ? advanceColumns(quotePrefix, 0) : 0;
		const body = quoted ? line.slice(quotePrefix.length) : line;
		// Indent of the line's content within its container, in columns. Absolute
		// tab stops, so a tab after a `> ` marker lands where a renderer puts it
		// rather than being charged the marker's own columns.
		const bodyIndent = (text: string): number =>
			advanceColumns(text, prefixCols) - prefixCols;
		const bodyIndentCols = bodyIndent(/^[ \t]*/.exec(body)?.[0] ?? '');
		const bodyBlank = body.trim() === '';

		// A fence inside a BLOCK QUOTE ends with the quote. A block quote ends at
		// a blank line or at a line carrying no quote marker, and a fence cannot
		// outlive the block that holds it, which is the same three-enders point
		// as the list case below.
		//
		// This is what makes not measuring a quoted fence's indent safe. Without
		// it, an opener recognised more freely runs to end of file and protects
		// everything after the quote, so real comments below are skipped and
		// reported as "converted 0". Executed: that is already true on main for
		// an unclosed `> ```, and this closes it rather than widening it.
		// Any DROP in quote depth ends it, which covers leaving the quote
		// altogether (a blank or unquoted line is depth 0) and stepping out of a
		// nested quote into its parent. An unquoted fence has depth 0, so this
		// never fires for one and its own enders below are untouched.
		if (openFence !== undefined && quoteDepth < openFence.quoteDepth) {
			out.push({ from: openFence.from, to: offset });
			openFence = undefined;
		}
		// A non-blank line is out of every open item whose content it is not
		// indented far enough to be in. Popping one at a time is what returns the
		// allowance to the PARENT item rather than to the margin.
		if (line.trim() !== '') {
			const col = indentColumns(line);
			while (openItems.length > 0 && col < (innerItem() ?? 0))
				openItems.pop();
			// An UNCLOSED fence ends with the item that HOLDS it, not at end of
			// file. A fence has three enders (its closing line, the end of the
			// block holding it, and EOF) and only the first and last were
			// modelled, because before the allowance went relative a fence could
			// only ever be top-level, where those two are the whole list.
			// Executed: `- item:` / blank / a four-column unterminated fence /
			// blank / ordinary prose left the prose protected to EOF, so a real
			// comment in it was skipped and reported as "converted 0".
			//
			// `itemDepth` is the stack height when the fence opened, so this
			// fires exactly when the item that contained it has been popped.
			if (
				openFence !== undefined &&
				openItems.length < openFence.itemDepth
			) {
				out.push({ from: openFence.from, to: offset });
				openFence = undefined;
			}
		}
		const fence = FENCE_LINE_RE.exec(body);
		// Three columns past the containing block's content, per CommonMark. A
		// fence run further in than that is not a fence; outside a list that is
		// the absolute three columns this used to hard-code.
		const fenceRun =
			fence !== null &&
			bodyIndent(fence[1] ?? '') <= (innerItem() ?? 0) + 3
				? fence[2]
				: undefined;
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
				itemDepth: openItems.length,
				quoteDepth,
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
			// The pop above already left only items this line sits inside, so a
			// sibling item has had its predecessor removed and this pushes the
			// new one; a nested item pushes on top of its parent.
			openItems.push(listContentColumns(line));
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
			// A quote's content follows the same block rules as the document's,
			// so an indented code block inside one is still code. Measured after
			// the markers, and only with no run open, exactly as outside a quote:
			// indented code cannot interrupt a paragraph, so a deep line under
			// quoted prose is a continuation of it.
			//
			// The quote branch used to have no notion of this at all, so a
			// `%%sample%%` in a quoted code block was rewritten and counted as a
			// success. That is this file's founding defect, surviving one axis
			// over because the axis was never swept.
			// A list item inside the quote is still a list item, and the indent
			// rules need its content indent the same way they do outside one.
			// The list branch above tests the UNSTRIPPED line, which never
			// matches through a `>`, so a quoted list never reached the stack:
			// `> - item` / `>` / `>     Continuation %%real%%` then measured the
			// continuation against no item at all, read four columns as code, and
			// skipped a real comment that converted correctly before.
			if (bodyBlank) {
				// A quote line carrying no content is a blank line INSIDE the
				// quote, and ends the paragraph there exactly as a blank line
				// does outside one. Without this the run carried straight across
				// it, so an indented block below read as a continuation of the
				// prose above and never got the chance to be code.
				flushRun();
			} else if (
				textRun === undefined &&
				opensIndentedCode(bodyIndentCols, bodyBlank, innerItem())
			) {
				out.push({ from: offset, to: lineEnd });
			} else if (textRun?.kind === 'quote') {
				// A quote already in progress carries on: consecutive `>` lines
				// are one block, so a span may run across them.
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
		} else if (
			textRun === undefined &&
			opensIndentedCode(bodyIndentCols, bodyBlank, innerItem())
		) {
			// Opens an indented code block, so it is not the first line of the
			// paragraph below it, and every character on it is code.
			//
			// PROTECTED outright, where this used to only scan the line for code
			// spans and leave the rest of it convertible. A renderer shows this
			// line inside a <pre><code>, so a `%%sample%%` on it is documentation
			// of the syntax, not a comment, and bulk convert rewrote it and
			// counted it as a success. Protecting the whole line also covers the
			// continuation lines of the block, which stay in this branch because
			// nothing here opens a run: a blank line inside the block flushes
			// nothing, so the line after it is still measured as code.
			out.push({ from: offset, to: lineEnd });
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
