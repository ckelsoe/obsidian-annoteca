// Parser and serializer for the Annoteca marker format. No Obsidian dependency.
// The format contract this implements is in dev-docs/annoteca/data-format.md.

import type {
	AnchorText,
	Addressed,
	Comment,
	Reply,
	Resolution,
} from './types';

// Canonical regex from data-format.md "greppable regex" section. Matches the
// entire marker, opening through closing. The category is captured; the rest of
// the inner content is captured for line-level parsing.
const MARKER_RE = /<!--\s*annoteca\/([a-z][a-z0-9-]*)\s*:([\s\S]*?)-->/g;

// Permissive trailing-line patterns. The strict category-name rules live in
// categories.ts. An author is any single token up to 32 chars: the class
// forbids only the characters that would break the format itself, namely
// whitespace (the field delimiter in [reply ...] / [resolved ...] lines), `]`
// (closes the bracket), and `<`/`>` (could form `-->` and break the HTML comment
// wrapper). Everything else (mixed case, dots, underscores, unicode) is allowed.
// Backward compatible: the old lowercase tags still match.
const ID_LINE_RE = /^\s*\[id=([a-z0-9]{1,32})\]\s*$/;
// Shared timestamp sub-pattern for every date-bearing line. Accepts the legacy
// date-only form (YYYY-MM-DD) and the full-timestamp form written since the
// timestamped-threads change (YYYY-MM-DDTHH:MM:SS, seconds optional). Markers
// from older versions still parse; one definition keeps the four line patterns
// below from drifting apart.
const STAMP_SRC = '\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2})?)?';
const DATE_LINE_RE = new RegExp(`^\\s*\\[date=(${STAMP_SRC})\\]\\s*$`);
const AUTHOR_LINE_RE = /^\s*\[author=([^\s\]<>]{1,32})\]\s*$/;
// Anchor value is permissive: anything but `]` or a line break, at any length.
//
// The length is UNBOUNDED here and capped at serialize time instead, which is
// what the comment this replaces already claimed. It was not true: the pattern
// required 1 to 200 characters, and neither end of that range was enforced on
// the way out. A longer value fell through to UNKNOWN_KV_LINE_RE, which absorbs
// the line and drops it, so an anchor that arrived from a hand edit or an older
// build was silently deleted on the next rewrite rather than parsed
// forward-compatibly. The `*` covers the other end: `[anchor=]` is now an empty
// structured line the walk consumes without inventing an anchor, instead of an
// unknown line.
const ANCHOR_LINE_RE = /^\s*\[anchor=([^\]\r\n]*)\]\s*$/;
const REPLY_LINE_RE = new RegExp(
	`^\\s*\\[reply\\s+([^\\s\\]<>]{1,32})\\s+(${STAMP_SRC})\\]:\\s?([\\s\\S]*)$`,
);
// Addressed trailing line (F-270). Same shape as reply/resolved. Positioned
// after [reply ...] lines and before any [resolved ...] line; at most one.
const ADDRESSED_LINE_RE = new RegExp(
	`^\\s*\\[addressed\\s+([^\\s\\]<>]{1,32})\\s+(${STAMP_SRC})\\]:\\s?([\\s\\S]*)$`,
);
const RESOLVED_LINE_RE = new RegExp(
	`^\\s*\\[resolved\\s+([^\\s\\]<>]{1,32})\\s+(${STAMP_SRC})\\]:\\s?([\\s\\S]*)$`,
);

// Forward-compatibility shapes for trailing lines this version does not know
// (per data-format.md Migration: ignore unknown structured trailing lines
// rather than failing). Deliberately narrow, and narrower than they could be.
//
// The rule these replace matched ANY line starting `[...]`, which silently ate
// the last line of a body whenever it began with a bracket. Markdown is full of
// bracket-leading constructs, and Obsidian's own wikilink is one, so a body
// ending in `[the guide](url)`, `[ref]: url`, `[^1]: note` or `[[Some Note]]`
// lost that line on the next parse with nothing to show the user.
//
// The two shapes below mirror the ones the format actually defines: a
// `[key=value]` line (id, date, author, anchor) and a `[key <author> <stamp>]:`
// note line (reply, addressed, resolved). Anything else stays in the body.
//
// The asymmetry is on purpose. Guessing "structured" on an ambiguous line
// deletes prose and cannot be undone from the file; guessing "body" on a real
// future structured line leaves it visible as text, which is ugly but recovers
// as soon as a version that understands it reads the marker. Prefer the
// recoverable failure.
const UNKNOWN_KV_LINE_RE = /^\s*\[[a-z][a-z0-9-]*=[^\]\r\n]*\]\s*$/;
const UNKNOWN_STAMPED_LINE_RE = new RegExp(
	`^\\s*\\[[a-z][a-z0-9-]*\\s+[^\\s\\]<>]{1,32}\\s+${STAMP_SRC}\\]:`,
);

// The lossless-original fence (F-271): a fenced block tagged annoteca-original
// inside the [addressed ...] note, holding the verbatim pre-edit text. Matched
// as whole lines (m flag); group 2 is the verbatim original. Tolerates CRLF and
// trailing whitespace on the fence lines.
//
// The delimiter length is VARIABLE and the closing run must match the opening
// one (the \1 backreference). A fixed three-backtick fence was a second
// terminator alongside `-->`: the captured text is arbitrary prose lifted out
// of the user's document, so it can contain a code block, and the first ``` line
// inside it closed the fence early. The addressed state, the id and the original
// itself were then lost, because the leftover fence lines stopped the backward
// walk and collapsed the trailing block into the body.
//
// Backward compatible in both directions. Existing markers use exactly three
// backticks and still match, because `{3,}` includes three. Serializing only
// widens the fence when the content holds a run that would close it, and content
// like that cannot round-trip through the old form at all, so no marker that
// reads correctly today is rewritten.
const ORIGINAL_FENCE_RE =
	/^(`{3,})annoteca-original[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;

// Longest run of backticks starting a line, which is the only place a run can
// close the fence (the closing pattern anchors to a whole line).
const LINE_LEADING_BACKTICKS_RE = /^[ \t]*(`+)/gm;

function fenceFor(content: string): string {
	let longest = 0;
	for (const match of content.matchAll(LINE_LEADING_BACKTICKS_RE))
		longest = Math.max(longest, (match[1] ?? '').length);
	return '`'.repeat(Math.max(3, longest + 1));
}

// Maximum visible characters in an anchor value before mid-truncation kicks
// in. 80 strikes the balance between "disambiguate the commented words" and
// "keep the marker file compact." Mirrors data-format.md.
export const ANCHOR_MAX_CHARS = 80;
const ANCHOR_ELLIPSIS = '…';

// Hard ceiling enforced on the way out, on the ESCAPED text, so the stored line
// cannot grow past it after `-->` escaping. Larger than ANCHOR_MAX_CHARS because
// that one is the selection-capture budget and this one is the format's: an
// anchor can also arrive already stored, and re-truncating a value that is
// merely long would edit the user's file for no reason.
const ANCHOR_LINE_MAX_CHARS = 200;

// Mid-truncate, keeping both ends searchable. Shared by the selection capture
// and the serialize-time cap, which had drifted: the capture truncated and the
// cap did not exist at all, so the only enforcement was a parser pattern that
// silently dropped anything longer.
function midTruncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = max - 1; // 1 char reserved for the ellipsis
	const headLen = Math.ceil(keep / 2);
	const tailLen = keep - headLen;
	const head = text.slice(0, headLen).trimEnd();
	const tail = text.slice(text.length - tailLen).trimStart();
	return `${head}${ANCHOR_ELLIPSIS}${tail}`;
}

// Author tokens are a closed grammar (`[^\s\]<>]{1,32}`, see AUTHOR_LINE_RE) and
// nothing enforced it on the way out. The tag reaches serialize from data.json,
// which is user-editable and arrives over sync, so whatever is in there was
// interpolated straight into the marker.
//
// Both failures are executed data loss rather than cosmetics. A display name
// with a space (`Charles Kelsoe`) makes the line unparseable, so the walk breaks
// on it and the ENTIRE trailing block above it collapses into the body: the id,
// the thread, the addressed state. A tag holding `-->` closes the HTML comment
// early and spills the rest of the marker into the document as visible prose.
//
// Repaired at the funnel rather than only at the settings boundary, because
// serialize() is the one place every marker write goes through and the ingress
// is untrusted by definition. The settings boundary gets its own validation
// separately; this must hold regardless of how the value arrived.
const AUTHOR_MAX_CHARS = 32;

export function sanitizeAuthorToken(raw: string): string {
	// `String(...)` rather than trusting the parameter type. The value can be
	// the author tag straight out of data.json, which is untyped at runtime, and
	// a hand edit or a synced backup can make it a number or null. Throwing here
	// would take the whole write with it, which is a worse failure than the one
	// this function exists to prevent. Validating the tag at the settings
	// boundary is a separate change; this has to hold either way.
	const token = String(raw ?? '')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/[\]<>]/g, '');
	const capped = capCodeUnits(token, AUTHOR_MAX_CHARS);
	return capped === '' ? 'user' : capped;
}

// Cap without leaving a lone surrogate behind. The grammar counts UTF-16 code
// units, so half of an emoji still matches the class and still round-trips; it
// just is not a character any more.
function capCodeUnits(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const ID_BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

// `-->` closes the HTML comment that wraps every marker, so it is the one
// sequence no free-text field can hold literally (data-format.md: "the only
// forbidden inner sequence is `-->`"). Nothing used to enforce that: a body
// containing it serialized to `<!-- annoteca/note: arrow --> here -->`, which
// re-parsed as the body "arrow" and left ` here -->` behind as visible text in
// the user's document.
//
// Escaped on write and restored on read, so the format is closed under
// arbitrary user text instead of forbidding a sequence and hoping. `--\>` is
// the escape because a backslash before `>` is markdown's own escape, so the
// stored form renders as `-->` wherever a body is rendered as markdown, and
// reads as intended even in the plain-text surfaces.
//
// The escape marker is itself escaped, which is what makes this reversible
// rather than merely lossy in a rare case. A body can legitimately already
// contain the literal text `--\>`, and a naive decode would hand it back as
// `-->`, silently rewriting the user's characters. That matters most in the
// `annoteca-original` fence, whose whole contract is that Reject restores the
// prose VERBATIM.
//
// So the rule is on the run of backslashes: writing adds one, reading removes
// one. `-->` <-> `--\>`, `--\>` <-> `--\\>`, and so on, which is a bijection at
// every depth. Escaping only ever ADDS backslashes, so it can never manufacture
// a new `-->` and can never fail to remove an existing one.
//
// An older plugin reading a file written by this one shows the literal `--\>`
// rather than losing the line, which is the degradation the format's Migration
// section asks for.
//
// KNOWN LIMITATION, accepted deliberately. A marker written BEFORE this encoding
// existed whose text legitimately contained `--\>` is indistinguishable from an
// encoded terminator, because the old format carries no sentinel. Such a body
// reads back with one backslash removed.
//
// The blast radius is small and it is pinned by tests. Decoding on read and
// encoding on write are inverses, so parse + serialize is a FIXED POINT: an
// affected file is never rewritten by opening a vault, and repeated edits do not
// walk the text further on each pass. What actually differs is the displayed
// text, and the prose Reject restores, by that one character.
//
// The alternative is a version sentinel in the format, which means a breaking
// change and the migration machinery data-format.md requires for one. That is
// not worth it against a corruption bug that loses whole lines today.
const TERMINATOR_RUN_RE = /--(\\*)>/g;
const ESCAPED_RUN_RE = /--(\\+)>/g;

function escapeTerminator(text: string): string {
	return text.replace(
		TERMINATOR_RUN_RE,
		(_match, slashes: string) => `--\\${slashes}>`,
	);
}

function unescapeTerminator(text: string): string {
	return text.replace(
		ESCAPED_RUN_RE,
		(_match, slashes: string) => `--${slashes.slice(1)}>`,
	);
}

// `-->` is not the only sequence that can break a marker. Every bracketed
// trailing line is a SINGLE-LINE grammar: parseInnerContent splits the inner
// content on `\n` and matches each line against one pattern. A newline anywhere
// in a reply body, an anchor, or an addressed/resolution note therefore emits a
// continuation line that matches nothing, the backward walk breaks on it
// immediately, and every structured line above it, the `[reply ...]` itself and
// the `[id=...]` with it, is absorbed into the body. The comment loses its
// thread and its identity, which breaks starring, drafts, Copy ID, and the
// freshComment re-lookup this change relies on.
//
// Nothing upstream prevents it: the Hub's reply box is a rows=3 textarea with no
// keydown handler, so Enter inserts a newline, and rendering replies as markdown
// makes a multi-line reply the invited usage rather than an odd one.
//
// Collapsing a run of line breaks to a single space keeps every word the user
// wrote and costs only the line break, which the format has never been able to
// store in these fields anyway. The body and the annoteca-original fence are
// deliberately NOT collapsed: both are multi-line by contract, the body because
// bodyMultiline re-emits it and the fence because it is delimited rather than
// line-oriented.
const LINE_BREAK_RUN_RE = /[\r\n]+/g;

function escapeInline(text: string): string {
	return escapeTerminator(text).replace(LINE_BREAK_RUN_RE, ' ');
}

export interface RawMarker {
	start: number;
	end: number;
	category: string;
	innerContent: string;
}

// Exported so callers that REWRITE a document can see where the markers already
// are. imports.ts is the one that needs it: a bulk conversion that cannot tell
// marker text from ordinary text converts the `%%...%%` inside an existing
// marker's body and nests a marker in a marker.
export function scanMarkers(content: string): RawMarker[] {
	const out: RawMarker[] = [];
	MARKER_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = MARKER_RE.exec(content)) !== null) {
		const full = match[0];
		const category = match[1];
		const inner = match[2];
		if (category === undefined || inner === undefined) continue;
		out.push({
			start: match.index,
			end: match.index + full.length,
			category,
			innerContent: inner,
		});
	}
	return out;
}

interface ParsedTail {
	body: string;
	id: string | undefined;
	date: string | undefined;
	author: string | undefined;
	anchor: AnchorText | undefined;
	replies: Reply[];
	addressed: Addressed | undefined;
	resolution: Resolution | undefined;
}

interface FenceBlock {
	start: number;
	end: number;
	content: string;
}

function findOriginalFences(inner: string): FenceBlock[] {
	const out: FenceBlock[] = [];
	for (const match of inner.matchAll(ORIGINAL_FENCE_RE)) {
		const content = match[2];
		if (content === undefined || match.index === undefined) continue;
		out.push({
			start: match.index,
			end: match.index + match[0].length,
			content,
		});
	}
	return out;
}

// Character offset of the LAST [addressed ...] line that is not itself inside a
// fence, or -1.
//
// Last, not first, because that is the one the walk itself keeps: it runs
// backward and takes the first [addressed ...] it meets. Anchoring anywhere
// else attributes a fence to a note the parsed comment does not carry.
//
// Last is also what cannot be fooled by a marker quoted inside a body. The
// trailing block is a SUFFIX of the lines, so a real [addressed ...] always
// sits below a quoted one; the last one is therefore the real one whenever
// there is a real one at all. When there is not, the walk comes back with no
// addressed note and parseInnerContent throws the strip away.
//
// FENCED CONTENT IS SKIPPED, and that is not an edge case. The fence holds
// prose lifted verbatim out of the user's document, so it can hold a line
// shaped like [addressed ...] the same way it can hold a code fence or a `-->`,
// and serialize() writes exactly that. Counting one would put the anchor INSIDE
// the block, which sits before it, so the real fence would look like a body
// fence and be left in place to stop the walk. That is the whole failure this
// function exists to prevent, arriving through the back door.
function lastAddressedOffset(inner: string, fences: FenceBlock[]): number {
	let offset = 0;
	let found = -1;
	let next = 0;
	for (const line of inner.split('\n')) {
		let fence = fences[next];
		while (fence !== undefined && fence.end <= offset) {
			next++;
			fence = fences[next];
		}
		const insideFence = fence !== undefined && offset >= fence.start;
		if (!insideFence && ADDRESSED_LINE_RE.test(line)) found = offset;
		offset += line.length + 1;
	}
	return found;
}

interface StrippedFence {
	stripped: string;
	originalText: string;
}

// Lift the annoteca-original fence out of the inner content (F-271).
//
// The strip does TWO jobs, and they are easy to conflate:
//
//   1. attribute the fenced text to the [addressed ...] note, and
//   2. remove the block, so the backward line-walk is not stopped by it.
//
// Job 2 is not optional. The walk is line-oriented, and a fence line matches
// nothing, so a fence left in place ends the walk on the spot and collapses
// every structured line above it (the [addressed ...] itself, the [id=...], the
// replies) into the body. That is silent, permanent damage to a marker that was
// perfectly well-formed, so findMalformedMarkers never flags it.
//
// So the question a fence has to answer is NOT "is this one adjacent to the
// [addressed ...] line" but "is this one the addressed note's original". Only
// the second question is safe to answer with `continue`.
//
// The rule is position, not adjacency: a fence is the original if it appears
// anywhere after the last [addressed ...] line. serialize() writes it
// immediately after, but nothing in the format requires that, and
// data-format.md only ever said "inside the [addressed ...] note". A blank line
// before a fenced block is ordinary Markdown, an assistant writing a marker by
// hand puts one there, and [reply ...] or [resolved ...] lines can sit in
// between.
//
// A fence ABOVE that line, or in a marker with no addressed note at all, is
// body text and stays put: a comment that documents the format by showing a
// fence is a normal thing to write, and the exported skill describes the fence,
// so assistants write them too.
//
// THE ONE CASE THAT STAYS AMBIGUOUS, and it is irreducible. A body whose LAST
// lines quote the format ([addressed ...] then a fence, with nothing but the
// trailing block after them) is byte-identical to a real addressed note. The
// quote is absorbed: the comment gains an addressed state it did not mean.
//
// Do not "fix" this by requiring the fence to touch the [addressed ...] line.
// That was tried, and it is the trade running the wrong way. Adjacency turns a
// real, well-formed marker into permanent damage (the whole trailing block
// collapses into the body, Reject loses the prose it was holding), while this
// costs a misread on a marker whose every character still survives the next
// rewrite. Prefer the recoverable failure, which is the same rule the
// forward-compatibility shapes above are chosen by. The pin is in
// __tests__/parser.test.ts, "absorbs a format example that ends a body".
//
// Returns undefined when there is nothing to lift, in which case the caller
// walks the untouched content.
function stripOriginalFence(inner: string): StrippedFence | undefined {
	const fences = findOriginalFences(inner);
	if (fences.length === 0) return undefined;
	const addressedAt = lastAddressedOffset(inner, fences);
	if (addressedAt < 0) return undefined;

	let originalText: string | undefined;
	let kept = '';
	let cursor = 0;
	for (const fence of fences) {
		if (fence.start <= addressedAt) continue;
		// Every attributable fence is removed, not just the one that supplies
		// the original. A second one is degenerate (serialize writes at most
		// one), but leaving it behind would stop the walk, which is the failure
		// this whole function exists to prevent. Dropping the extra block is the
		// same trade the walk already makes for a duplicate [addressed ...] or
		// [resolved ...] line: the format carries one, so the first wins.
		kept += inner.slice(cursor, fence.start).replace(/\r?\n$/, '');
		cursor = fence.end;
		originalText ??= unescapeTerminator(fence.content);
	}
	if (originalText === undefined) return undefined;
	return { stripped: kept + inner.slice(cursor), originalText };
}

function parseInnerContent(inner: string): ParsedTail {
	// Lift the fence out first, then check the walk's own verdict: if it did
	// not come back with an addressed note, the [addressed ...] line the fence
	// was attributed to was body text (a marker quoted inside a comment, say),
	// so the strip was wrong and the fence is prose. Re-walk the untouched
	// content rather than deleting it. The walk classifies body vs trailing
	// block; asking it is what keeps a second, drifting copy of that rule out
	// of this function.
	const lifted = stripOriginalFence(inner);
	if (lifted !== undefined) {
		const parsed = walkTrailingLines(
			lifted.stripped.split('\n'),
			lifted.originalText,
		);
		if (parsed.addressed !== undefined) return parsed;
	}
	return walkTrailingLines(inner.split('\n'), undefined);
}

// The backward walk that separates the trailing block from the body.
//
// TWO RULES GOVERN A SINGLETON LINE (id, date, author, anchor, addressed,
// resolution), and both exist because the body sits ABOVE the trailing block and
// can legitimately contain a line shaped exactly like one of them. serialize()
// emits the body raw, so a comment whose text quotes the format round-trips
// through here.
//
//   1. FIRST MET WINS. The walk runs bottom-up, so the first line of a kind it
//      meets is the bottom-most one, which is the one serialize() wrote. The
//      four `[key=value]` singletons used to assign unconditionally, so the
//      body-side copy won instead: a comment whose body ended `[id=deadbeef]`
//      came back carrying that id, which orphans its stars, drafts and every
//      later re-lookup, and rewrites the wrong marker on the next write.
//
//   2. A DUPLICATE ENDS THE WALK WITHOUT ABSORBING. Meeting a second line of a
//      kind already assigned means the walk has reached body text, so it stops
//      and leaves that line where it is. Absorbing it instead deleted it: the
//      value was ignored (rule 1) but `bodyEndExclusive` still moved past it, so
//      the body lost its last line with nothing to show the user.
//
// THE CASE THAT STAYS AMBIGUOUS, and it is irreducible. A body whose last line
// mimics a kind the marker does NOT already carry is indistinguishable from a
// real trailing line: `[reply mallory 2020-01-01]: injected` at the end of a
// body becomes a real reply, and an `[id=...]` on an id-less marker becomes its
// id. Nothing in the text says otherwise. The rules above only fix the case
// where the marker's own line is present to be preferred, which is every marker
// this plugin writes. Replies are not singletons at all, so a mimic simply joins
// the thread.
//
// Do not "fix" the ambiguous case by escaping bracket-leading body lines on
// write. That changes what every existing marker serializes to, and the failure
// it prevents (a phantom reply, visible in the thread) is recoverable, while the
// failure it would introduce (rewriting the user's prose) is not.
function walkTrailingLines(
	lines: string[],
	originalText: string | undefined,
): ParsedTail {
	let id: string | undefined;
	let date: string | undefined;
	let author: string | undefined;
	let anchor: AnchorText | undefined;
	const replies: Reply[] = [];
	let addressed: Addressed | undefined;
	let resolution: Resolution | undefined;

	// Tracked separately from the values because a line can be well-formed and
	// still yield no value: `[anchor=]` is a real structured line carrying
	// nothing, and a second one above it is still a duplicate.
	let seenId = false;
	let seenDate = false;
	let seenAuthor = false;
	let seenAnchor = false;
	let seenAddressed = false;
	let seenResolution = false;

	let bodyEndExclusive = lines.length;

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;

		if (line.trim() === '') {
			bodyEndExclusive = i;
			continue;
		}

		const idMatch = ID_LINE_RE.exec(line);
		if (idMatch && idMatch[1] !== undefined) {
			if (seenId) break;
			seenId = true;
			id = idMatch[1];
			bodyEndExclusive = i;
			continue;
		}

		const dateMatch = DATE_LINE_RE.exec(line);
		if (dateMatch && dateMatch[1] !== undefined) {
			if (seenDate) break;
			seenDate = true;
			date = dateMatch[1];
			bodyEndExclusive = i;
			continue;
		}

		const authorMatch = AUTHOR_LINE_RE.exec(line);
		if (authorMatch && authorMatch[1] !== undefined) {
			if (seenAuthor) break;
			seenAuthor = true;
			author = authorMatch[1];
			bodyEndExclusive = i;
			continue;
		}

		const anchorMatch = ANCHOR_LINE_RE.exec(line);
		if (anchorMatch && anchorMatch[1] !== undefined) {
			if (seenAnchor) break;
			seenAnchor = true;
			const raw = unescapeTerminator(anchorMatch[1]);
			// An empty value is a structured line with nothing in it, not an
			// anchor of "". serialize() never writes one, but a hand edit can,
			// and inventing an empty anchor would make the marker claim it is
			// anchored to nothing.
			if (raw.trim() !== '') {
				anchor = {
					text: raw,
					truncated: raw.includes(ANCHOR_ELLIPSIS),
				};
			}
			bodyEndExclusive = i;
			continue;
		}

		const replyMatch = REPLY_LINE_RE.exec(line);
		if (
			replyMatch &&
			replyMatch[1] !== undefined &&
			replyMatch[2] !== undefined
		) {
			replies.push({
				author: replyMatch[1],
				date: replyMatch[2],
				body: unescapeTerminator(replyMatch[3] ?? ''),
			});
			bodyEndExclusive = i;
			continue;
		}

		const addressedMatch = ADDRESSED_LINE_RE.exec(line);
		if (
			addressedMatch &&
			addressedMatch[1] !== undefined &&
			addressedMatch[2] !== undefined
		) {
			if (seenAddressed) break;
			seenAddressed = true;
			addressed = {
				author: addressedMatch[1],
				date: addressedMatch[2],
				note: unescapeTerminator(addressedMatch[3] ?? ''),
				original: originalText,
			};
			bodyEndExclusive = i;
			continue;
		}

		const resolvedMatch = RESOLVED_LINE_RE.exec(line);
		if (
			resolvedMatch &&
			resolvedMatch[1] !== undefined &&
			resolvedMatch[2] !== undefined
		) {
			if (seenResolution) break;
			seenResolution = true;
			resolution = {
				author: resolvedMatch[1],
				date: resolvedMatch[2],
				note: unescapeTerminator(resolvedMatch[3] ?? ''),
			};
			bodyEndExclusive = i;
			continue;
		}

		// Forward-compatibility: trailing lines in a shape the format defines
		// but this version does not recognize are still treated as structured.
		// They never re-emerge in serialize() because the Comment shape does
		// not carry them. See UNKNOWN_KV_LINE_RE / UNKNOWN_STAMPED_LINE_RE for
		// why these two shapes and not "any bracket-leading line".
		if (
			UNKNOWN_KV_LINE_RE.test(line) ||
			UNKNOWN_STAMPED_LINE_RE.test(line)
		) {
			bodyEndExclusive = i;
			continue;
		}

		break;
	}

	const bodyLines = lines.slice(0, bodyEndExclusive);
	const bodyRaw = bodyLines.join('\n');
	const body = unescapeTerminator(bodyRaw.trim());

	replies.reverse();
	// Stable-sort by timestamp so a thread reads oldest-first even if its
	// marker was rewritten with replies out of order (e.g. an assistant
	// regenerating the block). Array.sort is stable, so replies that share a
	// stamp keep their file order as the tiebreak. ISO stamps compare correctly
	// with a plain lexical compare, and a legacy date-only stamp sorts at the
	// start of its day relative to same-day timestamped replies.
	replies.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

	return { body, id, date, author, anchor, replies, addressed, resolution };
}

export function parseAll(content: string): Comment[] {
	const out: Comment[] = [];
	for (const raw of scanMarkers(content)) {
		const tail = parseInnerContent(raw.innerContent);
		out.push({
			id: tail.id,
			category: raw.category,
			body: tail.body,
			date: tail.date,
			author: tail.author,
			anchor: tail.anchor,
			replies: tail.replies,
			addressed: tail.addressed,
			resolution: tail.resolution,
			marker: { start: raw.start, end: raw.end },
		});
	}
	return out;
}

export function parseAt(content: string, start: number): Comment | undefined {
	MARKER_RE.lastIndex = start;
	const match = MARKER_RE.exec(content);
	if (!match || match.index !== start) return undefined;
	const category = match[1];
	const inner = match[2];
	if (category === undefined || inner === undefined) return undefined;
	const tail = parseInnerContent(inner);
	return {
		id: tail.id,
		category,
		body: tail.body,
		date: tail.date,
		author: tail.author,
		anchor: tail.anchor,
		replies: tail.replies,
		addressed: tail.addressed,
		resolution: tail.resolution,
		marker: { start: match.index, end: match.index + match[0].length },
	};
}

export interface SerializeInput {
	id?: string;
	category: string;
	body: string;
	date?: string;
	author?: string;
	anchor?: AnchorText;
	replies?: readonly Reply[];
	addressed?: Addressed;
	resolution?: Resolution;
}

export function serialize(c: SerializeInput): string {
	// Every free-text field is escaped on the way out and unescaped on the way
	// back in, so a body, note, anchor or reply holding `-->` round-trips
	// instead of closing the marker early. See escapeTerminator.
	const body = escapeTerminator(c.body);
	const hasMetadata =
		c.id !== undefined ||
		c.date !== undefined ||
		c.author !== undefined ||
		c.anchor !== undefined;
	const hasReplies = (c.replies?.length ?? 0) > 0;
	const hasAddressed = c.addressed !== undefined;
	const hasResolution = c.resolution !== undefined;
	const bodyMultiline = body.includes('\n');

	if (
		!hasMetadata &&
		!hasReplies &&
		!hasAddressed &&
		!hasResolution &&
		!bodyMultiline
	) {
		return `<!-- annoteca/${c.category}: ${body} -->`;
	}

	const lines: string[] = [];
	lines.push(`<!-- annoteca/${c.category}: ${body}`);
	if (c.id !== undefined) lines.push(`[id=${c.id}]`);
	if (c.date !== undefined) lines.push(`[date=${c.date}]`);
	if (c.author !== undefined)
		lines.push(`[author=${sanitizeAuthorToken(c.author)}]`);
	if (c.anchor !== undefined) {
		// `]` closes the bracket, so it is to the anchor what `-->` is to the
		// marker: not escapable within the line grammar, only removable.
		// buildAnchorFromSelection already strips it, which is why no capture
		// path can produce one today; this is the same guard at the funnel every
		// write goes through, so a stored or hand-edited anchor cannot break the
		// line either.
		const text = midTruncate(
			escapeInline(c.anchor.text).replace(/\]/g, ''),
			ANCHOR_LINE_MAX_CHARS,
		);
		if (text.trim() !== '') lines.push(`[anchor=${text}]`);
	}
	for (const r of c.replies ?? []) {
		lines.push(
			`[reply ${sanitizeAuthorToken(r.author)} ${r.date}]: ${escapeInline(r.body)}`,
		);
	}
	if (c.addressed) {
		const rawNote = escapeInline(c.addressed.note);
		const note = rawNote.length > 0 ? ` ${rawNote}` : '';
		lines.push(
			`[addressed ${sanitizeAuthorToken(c.addressed.author)} ${c.addressed.date}]:${note}`,
		);
		// F-271: the verbatim replaced text lives in a fenced annoteca-original
		// block directly after the [addressed ...] line. The captured prose is
		// arbitrary text lifted out of the user's document, so it can contain
		// BOTH sequences that would end the block early: `-->`, which closes the
		// HTML comment, and a fence line, which closes the fence. The first is
		// escaped; the second is handled by widening the delimiter past anything
		// in the content, since escaping backticks would change the text the
		// fence exists to preserve verbatim.
		if (c.addressed.original !== undefined) {
			const original = escapeTerminator(c.addressed.original);
			const fence = fenceFor(original);
			lines.push(`${fence}annoteca-original`);
			lines.push(original);
			lines.push(fence);
		}
	}
	if (c.resolution) {
		const rawNote = escapeInline(c.resolution.note);
		const note = rawNote.length > 0 ? ` ${rawNote}` : '';
		lines.push(
			`[resolved ${sanitizeAuthorToken(c.resolution.author)} ${c.resolution.date}]:${note}`,
		);
	}
	lines.push(`-->`);
	return lines.join('\n');
}

// Normalize a selected text range into a storable anchor. Strips `]` and
// line breaks (the parser's tail regex requires single-line, non-`]` values),
// collapses internal whitespace, and mid-truncates to ANCHOR_MAX_CHARS when
// the selection is longer.
//
// Returns undefined for empty or whitespace-only selections, which the
// composer treats as "no anchor" (cursor-position comment).
export function buildAnchorFromSelection(raw: string): AnchorText | undefined {
	const cleaned = raw
		.replace(/[\r\n]+/g, ' ')
		.replace(/\]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length === 0) return undefined;

	if (cleaned.length <= ANCHOR_MAX_CHARS) {
		return { text: cleaned, truncated: false };
	}
	return { text: midTruncate(cleaned, ANCHOR_MAX_CHARS), truncated: true };
}

// 8-character lowercase base36 ID. Uses Math.random so it works in the
// Obsidian renderer process. Collision probability ~1 in 2.8 trillion;
// callers retry against the vault-wide index on collision.
export function generateId(): string {
	let id = '';
	for (let i = 0; i < 8; i++) {
		const idx = Math.floor(Math.random() * ID_BASE36_ALPHABET.length);
		id += ID_BASE36_ALPHABET.charAt(idx);
	}
	return id;
}

export function todayISO(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, '0');
	const d = String(now.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

// Full local timestamp YYYY-MM-DDTHH:MM:SS, no timezone (matching the format's
// existing no-timezone convention). Used for new comments, replies, resolutions
// and addressed stamps so fast back-and-forth threads stay ordered to the
// second. todayISO remains for the rare date-granularity case.
export function nowISO(now: Date = new Date()): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `${date}T${time}`;
}

// What kind of problem was found. Split out because the three need different
// words and different fixes, and because the two new ones describe a document
// that still PARSES, which the original reason line does not cover.
export type MalformedMarkerKind =
	'malformed' | 'unclosed-opener' | 'possible-merge';

export interface MalformedMarker {
	start: number;
	excerpt: string;
	reason: string;
	kind: MalformedMarkerKind;
}

const OPENING_TOKEN_RE =
	/<!--\s*annoteca\/(?![a-z][a-z0-9-]*\s*:)[^>]{0,120}-->|<!--\s*annoteca\/[^a-z][^>]*-->/g;

// A marker opener, anywhere. Deliberately looser than MARKER_RE's category group
// (case-insensitive, leading digits allowed) so a near-miss is still reported.
//
// NOT anchored to a line start, though that would cut the false positives. The
// plugin places a marker at the HEAD of the text it concerns, so most markers in
// a real vault sit mid-line after prose, and anchoring here missed exactly the
// shape this diagnostic exists to catch.
//
// The cost is a false positive on a note that quotes an opener inside a comment
// body, since serialize escapes `-->` but has no reason to escape `<!--`. That
// trade runs the right way: this reports, it never rewrites, so a false positive
// costs a line in a report the user can dismiss, while a false negative costs a
// paragraph that has silently vanished from reading view. The reason text says
// "probably" for the same reason.
const OPENER_ANYWHERE_RE = /<!--\s*annoteca\/[a-z0-9-]+:/gi;

// Reported when an opener has no `-->` of its own.
//
// This is the diagnostic half of the merge failure. Delete one `-->`, or let an
// assistant hand-write a marker and forget the close, and MARKER_RE pairs that
// opener with the NEXT marker's terminator: everything between them, prose and
// all, becomes inner content of one merged comment. The prose disappears from
// reading view, the second comment disappears from the Hub, and the merged
// comment carries the second marker's id under the first one's category. A
// lifecycle write then cements it.
//
// Nothing flagged it, because OPENING_TOKEN_RE only ever matched candidates that
// themselves end in `-->`, and the merged result is a perfectly well-formed
// marker. Only the count of openers against the count of markers gives it away.
//
// PARSING IS NOT CHANGED HERE. Whether an unclosed opener should refuse to merge
// is a format question with its own irreducible ambiguity (the opener may be
// quoted prose), and changing it silently would rewrite how existing documents
// read. The merge behaviour is pinned by test; this only makes it visible.
export function findMalformedMarkers(content: string): MalformedMarker[] {
	const markers = scanMarkers(content);
	const valid = new Set<number>();
	for (const m of markers) valid.add(m.start);

	const out: MalformedMarker[] = [];
	const reported = new Set<number>();
	const excerptAt = (start: number): string =>
		content.slice(start, Math.min(content.length, start + 120));

	OPENING_TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = OPENING_TOKEN_RE.exec(content)) !== null) {
		if (valid.has(match.index)) continue;
		reported.add(match.index);
		out.push({
			start: match.index,
			excerpt: excerptAt(match.index),
			reason: 'Marker did not match the canonical Annoteca format.',
			kind: 'malformed',
		});
	}

	// One finding per containing marker, not per opener inside it, so a document
	// with several merged markers reads as several problems rather than a wall.
	const merged = new Set<number>();
	OPENER_ANYWHERE_RE.lastIndex = 0;
	while ((match = OPENER_ANYWHERE_RE.exec(content)) !== null) {
		const at = match.index;
		if (valid.has(at) || reported.has(at)) continue;
		const container = markers.find((m) => at > m.start && at < m.end);
		if (container === undefined) {
			out.push({
				start: at,
				excerpt: excerptAt(at),
				reason: 'Marker opener has no closing `-->`.',
				kind: 'unclosed-opener',
			});
			continue;
		}
		if (merged.has(container.start)) continue;
		merged.add(container.start);
		out.push({
			start: container.start,
			excerpt: excerptAt(container.start),
			reason: 'This marker contains another marker opener, so two markers have probably merged into one. Check for a missing `-->`.',
			kind: 'possible-merge',
		});
	}

	out.sort((a, b) => a.start - b.start);
	return out;
}
