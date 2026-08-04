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

// An inline code span. Applied per line and only outside fenced blocks.
const INLINE_CODE_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

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

	let offset = 0;
	let openFence: { char: string; length: number; from: number } | undefined;
	for (const line of content.split('\n')) {
		const lineEnd = offset + line.length;
		if (insideMarker(offset)) {
			// Neither opens nor closes a fence, and contributes no code spans. A
			// fence opened OUTSIDE a marker stays open across it, which is what
			// a renderer does too.
			offset = lineEnd + 1;
			continue;
		}
		const fence = FENCE_LINE_RE.exec(line);
		const run = fence?.[2];
		if (openFence !== undefined) {
			// A closing fence is the same character, at least as long, with
			// nothing after it.
			if (
				run !== undefined &&
				run.charAt(0) === openFence.char &&
				run.length >= openFence.length &&
				(fence?.[3] ?? '').trim() === ''
			) {
				out.push({ from: openFence.from, to: lineEnd });
				openFence = undefined;
			}
		} else if (run !== undefined) {
			openFence = {
				char: run.charAt(0),
				length: run.length,
				from: offset,
			};
		} else {
			INLINE_CODE_RE.lastIndex = 0;
			for (const span of line.matchAll(INLINE_CODE_RE)) {
				if (span.index === undefined) continue;
				out.push({
					from: offset + span.index,
					to: offset + span.index + span[0].length,
				});
			}
		}
		offset = lineEnd + 1;
	}
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
