// Parser and serializer for the Annoteca marker format. No Obsidian dependency.
// The format contract this implements is in dev-docs/annoteca/data-format.md.

import type {
	AnchorText,
	Addressed,
	Comment,
	MarkerRange,
	Reply,
	Resolution,
} from './types';

// Canonical regex from data-format.md "greppable regex" section. Matches the
// entire marker, opening through closing. The category is captured; the rest of
// the inner content is captured for line-level parsing.
//
// The category group is factored out because two other places have to reject
// anything this cannot read back, and all three have to be the SAME rule.
// Written out separately they drift, and a drift here is invisible: the marker
// is written, and nothing notices until the next parse silently fails to find
// the comment.
const CATEGORY_SRC = '[a-z][a-z0-9-]*';
// The opener, factored out for the same reason the category is: three places
// have to agree on what one looks like. MARKER_RE pairs it with a terminator,
// scanMarkers refuses to pair ACROSS one, and findMalformedMarkers reports the
// ones that never closed. A drift between those three is invisible in exactly
// the way this file's other shared sources are.
const OPENER_SRC = '<!--\\s*annoteca/';
const TERMINATOR = '-->';
const MARKER_RE = new RegExp(
	`${OPENER_SRC}(${CATEGORY_SRC})\\s*:([\\s\\S]*?)${TERMINATOR}`,
	'g',
);
const SERIALIZABLE_CATEGORY_RE = new RegExp(`^${CATEGORY_SRC}$`);
// Any marker opener, used to detect one nested inside another marker's inner
// content. Case-sensitive and category-exact, matching MARKER_RE: an opener
// this cannot read is not one that could have consumed the terminator.
const NESTED_OPENER_RE = new RegExp(`${OPENER_SRC}${CATEGORY_SRC}\\s*:`, 'g');
// Any HTML comment opener at all. A generic one inside a marker means the
// marker's `-->` may belong to it rather than to the marker, which is the same
// swallowed-prose failure by a different route. Reported, never re-paired: see
// findMalformedMarkers.
const HTML_OPENER_RE = /<!--/g;

// Can a category id survive a write and be found again? This is the grammar
// question, and it is NOT the same question as isValidCategoryName in
// categories.ts, which is the house style for a name the user is CREATING and
// is deliberately stricter (no double dashes, no trailing dash, no format
// keywords).
//
// The distinction matters at every ingress. `my--topic` breaks the house style
// but round-trips through the marker perfectly, so a stored category shaped
// like that is a working category, and validating stored data against the
// creation rule would delete a category that does its job. Enforce the house
// style where a name is being made up; enforce this where one is being read
// back or written out.
export function isSerializableCategory(category: string): boolean {
	return SERIALIZABLE_CATEGORY_RE.test(category);
}

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
// The author-token class, shared the same way STAMP_SRC is. It appeared in five
// patterns here and three more in settings.ts, and eight copies of a grammar is
// eight chances for one of them to drift from the format.
const AUTHOR_SRC = '[^\\s\\]<>]{1,32}';
const AUTHOR_LINE_RE = new RegExp(`^\\s*\\[author=(${AUTHOR_SRC})\\]\\s*$`);
const AUTHOR_TOKEN_RE = new RegExp(`^${AUTHOR_SRC}$`);

// Is this string usable as an author token as it stands? The settings tab asks
// this before storing a tag and before offering it in the collaborator list, so
// the question is answered here, next to the lines the answer is about, rather
// than restated at each call site.
//
// An empty string is NOT a token, and callers that treat empty as "no tag set"
// have to say so themselves. Folding that in here would make the predicate
// answer two questions and hide the difference between "nothing configured" and
// "something unusable".
export function isAuthorToken(tag: string): boolean {
	return AUTHOR_TOKEN_RE.test(tag);
}

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
	`^\\s*\\[reply\\s+(${AUTHOR_SRC})\\s+(${STAMP_SRC})\\]:\\s?([\\s\\S]*)$`,
);
// Addressed trailing line (F-270). Same shape as reply/resolved. Positioned
// after [reply ...] lines and before any [resolved ...] line; at most one.
const ADDRESSED_LINE_RE = new RegExp(
	`^\\s*\\[addressed\\s+(${AUTHOR_SRC})\\s+(${STAMP_SRC})\\]:\\s?([\\s\\S]*)$`,
);
const RESOLVED_LINE_RE = new RegExp(
	`^\\s*\\[resolved\\s+(${AUTHOR_SRC})\\s+(${STAMP_SRC})\\]:\\s?([\\s\\S]*)$`,
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
// A line matching one of them with a key this version has no name for is KEPT
// and re-emitted, not merely skipped. See the walk's unknown-line branch: the
// format's promise is to ignore what it does not understand, and absorbing a
// line and then dropping it on the next write is deleting it.
//
// The asymmetry is on purpose. Guessing "structured" on an ambiguous line
// deletes prose and cannot be undone from the file; guessing "body" on a real
// future structured line leaves it visible as text, which is ugly but recovers
// as soon as a version that understands it reads the marker. Prefer the
// recoverable failure.
const UNKNOWN_KV_LINE_RE = /^\s*\[[a-z][a-z0-9-]*=[^\]\r\n]*\]\s*$/;
const UNKNOWN_STAMPED_LINE_RE = new RegExp(
	`^\\s*\\[[a-z][a-z0-9-]*\\s+${AUTHOR_SRC}\\s+${STAMP_SRC}\\]:`,
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

// `-->` is only half of the marker's wrapper, and the other half was never
// encoded at all. An opener inside a marker's inner content is indistinguishable
// from a marker that forgot to close: MARKER_RE is lazy, so a `<!-- annoteca/x:`
// with no terminator of its own pairs with the NEXT marker's `-->`, and every
// line between them, prose included, becomes one merged comment's body. That is
// the failure this encoding exists to make decidable.
//
// Escaped exactly like the terminator, and for the same reason: it is the run of
// backslashes that carries the meaning, so writing adds one and reading removes
// one at every depth. `<!--` <-> `\<!--`, `\<!--` <-> `\\<!--`. A run of zero is
// therefore a REAL opener, which is what lets scanMarkers refuse to pair across
// one without guessing.
//
// `\<` is markdown's own escape, so a body quoting the format renders as the
// user typed it, and the escape doubles as protection in rendered output: an
// unescaped `<!--` in a rendered comment body would open an HTML comment in the
// rendered HTML and swallow whatever followed it there too.
//
// EVERY `<!--` is escaped, not just annoteca's own opener. A generic HTML
// comment nested in a body is the same swallowed-prose failure through a
// different terminator, and escaping both shapes costs one character in a body
// that mentions HTML comments at all.
//
// The same KNOWN LIMITATION as the terminator escape applies, with the same
// blast radius: a marker written before this encoding whose body legitimately
// held `\<!--` reads back with one backslash fewer. Encode and decode are
// inverses, so the FILE is a fixed point and nothing walks further on each pass.
const OPENER_RUN_RE = /(\\*)<!--/g;
const ESCAPED_OPENER_RUN_RE = /(\\+)<!--/g;

// Exported because the same escape is needed at a SECOND boundary, for the same
// reason in a different medium. Storage escapes `<!--` so the marker's own
// terminator cannot be claimed by a nested comment; rendering has to escape it
// so Obsidian's markdown renderer does not read the text as an HTML comment and
// hide it. Executed in a real vault: a body of `before <!-- x --> after` renders
// as "before  after", and an unmatched opener hides whatever follows it in the
// popover.
//
// The parse side unescapes before anything sees the body, which is correct (the
// body is the user's text, not the stored encoding), so the render boundary has
// to put the escape back rather than rely on the stored form. `\<` is markdown's
// own escape, so the run rule works unchanged here: text that already held
// `\<!--` renders as `\<!--`.
export function escapeOpener(text: string): string {
	return text.replace(
		OPENER_RUN_RE,
		(_match, slashes: string) => `\\${slashes}<!--`,
	);
}

function unescapeOpener(text: string): string {
	return text.replace(
		ESCAPED_OPENER_RUN_RE,
		(_match, slashes: string) => `${slashes.slice(1)}<!--`,
	);
}

// The two wrapper escapes, applied together. Neither can manufacture input for
// the other: the terminator escape only ever inserts a backslash before `>` and
// the opener escape only before `<`, so they commute, and unescaping in the
// mirror order is exact.
function escapeMarkerText(text: string): string {
	return escapeOpener(escapeTerminator(text));
}

function unescapeMarkerText(text: string): string {
	return unescapeTerminator(unescapeOpener(text));
}

// How many backslashes sit immediately before `index`.
//
// Written as a loop rather than a lookbehind on purpose. Lookbehind is a PARSE
// error in JavaScriptCore before iOS 16.4, so one anywhere in the sources stops
// the whole plugin loading on those devices; scripts/check-submission.mjs fails
// the build on it. This is the same question asked in a form that ships.
function backslashRunBefore(text: string, index: number): number {
	let run = 0;
	while (index - run - 1 >= 0 && text.charAt(index - run - 1) === '\\') run++;
	return run;
}

// Offset of the first UNESCAPED match of `re` in `text`, or -1. `re` must be a
// global regex; its lastIndex is reset here rather than trusted.
function firstUnescaped(text: string, re: RegExp): number {
	re.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		if (backslashRunBefore(text, match.index) === 0) return match.index;
	}
	return -1;
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
	return escapeMarkerText(text).replace(LINE_BREAK_RUN_RE, ' ');
}

// The trailing-line grammar, as a set. serialize() asks "would this body line be
// read back as one of these?" and the walk asks "is this line one this version
// does not know?", and both questions are about the SAME list. Written out twice
// they drift, and a drift here deletes a line of the user's prose.
const KNOWN_LINE_RES = [
	ID_LINE_RE,
	DATE_LINE_RE,
	AUTHOR_LINE_RE,
	ANCHOR_LINE_RE,
	REPLY_LINE_RE,
	ADDRESSED_LINE_RE,
	RESOLVED_LINE_RE,
];

function looksStructured(line: string): boolean {
	return (
		KNOWN_LINE_RES.some((re) => re.test(line)) ||
		UNKNOWN_KV_LINE_RE.test(line) ||
		UNKNOWN_STAMPED_LINE_RE.test(line)
	);
}

// A trailing line in a shape the format defines but this version does not know.
// Used to vet what serialize() re-emits: a line that is not one of these is body
// text, and writing it into the trailing block would corrupt the marker.
function isUnknownStructuredLine(line: string): boolean {
	if (KNOWN_LINE_RES.some((re) => re.test(line))) return false;
	return UNKNOWN_KV_LINE_RE.test(line) || UNKNOWN_STAMPED_LINE_RE.test(line);
}

// A body line that would be read back as a structured trailing line, and the
// backslash run already in front of its bracket.
const BRACKET_LEAD_RE = /^(\s*)(\\*)\[/;
const ESCAPED_BRACKET_LEAD_RE = /^(\s*)(\\+)\[/;

// Escape a body line that mimics a trailing line, so the walk cannot absorb it.
//
// The walk reads bottom-up and stops at the first line it cannot classify, so a
// body whose LAST lines quote the format is indistinguishable from a real
// trailing block. Executed, on a marker under stock settings: a body line
// `[author=mallory]` became the comment's author AND was deleted from the body;
// `[resolved mallory 2020-01-01]: done` silently flipped the comment to resolved
// and persisted a fabricated resolution; `[retry=3]` was absorbed as an unknown
// line and dropped with nothing to show the user.
//
// The comment this replaces declined the guard, on the grounds that escaping
// "changes what every existing marker serializes to" while a phantom reply is
// merely visible. Both halves turned out to be wrong. The blast radius is one
// character on a body line that ALREADY reads back as something the user did not
// write, and the failure is not cosmetic: the mimic wins the field AND the line
// leaves the file. That trade runs the other way, so the guard is now here.
//
// The rule is the backslash run, exactly as for the two wrapper escapes: writing
// adds one, reading removes one, and the test in both directions is whether the
// line with NO backslashes would parse as structured. A body line the format has
// no opinion about is left alone in both directions, so ordinary bracket-leading
// markdown (`[ref]: url`, `[^1]: note`, `[[Some Note]]`) never grows a backslash.
//
// EVERY matching line is escaped, not only the ones currently at risk at the
// bottom of the body. Escaping conditionally on position would mean that editing
// the last line of a body silently re-encodes a line above it, so the same text
// would store differently depending on what follows it.
function escapeStructuredLine(line: string): string {
	const match = BRACKET_LEAD_RE.exec(line);
	if (!match) return line;
	const indent = match[1] ?? '';
	const slashes = match[2] ?? '';
	const bracketed = line.slice(indent.length + slashes.length);
	if (!looksStructured(indent + bracketed)) return line;
	return `${indent}\\${slashes}${bracketed}`;
}

function unescapeStructuredLine(line: string): string {
	const match = ESCAPED_BRACKET_LEAD_RE.exec(line);
	if (!match) return line;
	const indent = match[1] ?? '';
	const slashes = match[2] ?? '';
	const bracketed = line.slice(indent.length + slashes.length);
	if (!looksStructured(indent + bracketed)) return line;
	return `${indent}${slashes.slice(1)}${bracketed}`;
}

// The body is the one multi-line free-text field, so it is the only one whose
// lines can be mistaken for the trailing block. Replies, notes and anchors are
// single-line by construction (escapeInline folds their line breaks away), and
// the annoteca-original fence is delimited rather than line-oriented and is
// lifted out before the walk runs.
function escapeBody(text: string): string {
	return escapeMarkerText(text)
		.split('\n')
		.map(escapeStructuredLine)
		.join('\n');
}

function unescapeBody(text: string): string {
	return unescapeMarkerText(
		text.split('\n').map(unescapeStructuredLine).join('\n'),
	);
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
		// AN OPENER INSIDE THE MATCH MEANS THIS ONE NEVER CLOSED.
		//
		// MARKER_RE is lazy, so it pairs an opener with the FIRST `-->` after it.
		// Delete one terminator, or let an assistant hand-write a marker and
		// forget the close, and the opener pairs with the NEXT marker's
		// terminator instead: the prose between them becomes inner content, the
		// second comment disappears from the Hub, and the merged comment carries
		// the second marker's id under the first one's category.
		//
		// That is not a display problem. Executed on the merged comment: deleting
		// it removes the reader's paragraph from the note, appending a reply
		// cements the merge, and nothing on the write path ever consulted the
		// diagnostic that could see it.
		//
		// The terminator belongs to the LAST opener before it, so resuming the
		// scan at the nested opener is what finds the real marker. With three
		// openers stacked up this walks down one at a time until the match is
		// clean. lastIndex always advances past match.index (an opener cannot
		// nest inside itself), so the loop cannot stall.
		//
		// A body that legitimately QUOTES an opener is why serialize() escapes
		// `<!--` now: an unescaped one is evidence, an escaped one is prose.
		//
		// KNOWN COST, and it is not free. A marker written BEFORE that encoding
		// whose body quotes an opener is byte-identical to this, because the old
		// serializer escaped `-->` and had no reason to escape `<!--`. Such a
		// marker parses correctly today and splits here: the comment comes back
		// under the QUOTED category carrying the outer marker's id, its body
		// truncated to the text after the quote, and its range starting
		// mid-body. A later write then rewrites only that inner range and leaves
		// the outer opener dangling in the note.
		//
		// Nothing is deleted, and the note is not touched until the user acts:
		// the dangling opener is reported the moment the note is indexed, and
		// every verb that REMOVES a marker refuses while it stands. Pinned in
		// __tests__/parser.test.ts, "a marker written before the opener escape".
		//
		// There is no parse-side discriminator to be had. An unescaped opener in
		// a body and an opener that never closed are the same bytes, which is
		// what the comment on findMalformedMarkers used to mean by "its own
		// irreducible ambiguity". The escape is what makes the question
		// decidable, and it can only decide it going forward.
		const innerStart =
			match.index + full.length - inner.length - TERMINATOR.length;
		const nested = firstUnescaped(inner, NESTED_OPENER_RE);
		if (nested >= 0) {
			MARKER_RE.lastIndex = innerStart + nested;
			continue;
		}
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
	unknownLines: string[];
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
		originalText ??= unescapeMarkerText(fence.content);
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
// THE CASE THESE TWO RULES CANNOT REACH. A body whose last line mimics a kind
// the marker does NOT already carry is indistinguishable from a real trailing
// line: `[reply mallory 2020-01-01]: injected` at the end of a body becomes a
// real reply, and an `[id=...]` on an id-less marker becomes its id. The rules
// above only fix the case where the marker's own line is present to be
// preferred, and under stock settings a normal marker carries neither
// `[author=...]` nor `[anchor=...]`. Replies are not singletons at all, so a
// mimic simply joins the thread.
//
// That is irreducible HERE, and it is decided on the write side instead: see
// escapeStructuredLine, which escapes any body line that would read back as a
// structured one. The comment this replaces argued against exactly that, on the
// grounds that escaping "changes what every existing marker serializes to" while
// the failure it prevented was "recoverable". Both halves were wrong. The reach
// is one character on a line that already comes back as something the user did
// not write, and the mimic does not merely appear in the thread: it wins the
// field AND the line leaves the file, which is the unrecoverable direction.
//
// A marker that arrives WITHOUT having gone through serialize (hand-written, or
// written by an assistant) still hits this, which is why the exported skill now
// teaches the escape. The walk stays as it is: parse-side, the ambiguity is
// real, and guessing "structured" on an ambiguous line deletes prose.
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
	const unknownLines: string[] = [];

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
			const raw = unescapeMarkerText(anchorMatch[1]);
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
				body: unescapeMarkerText(replyMatch[3] ?? ''),
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
				note: unescapeMarkerText(addressedMatch[3] ?? ''),
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
				note: unescapeMarkerText(resolvedMatch[3] ?? ''),
			};
			bodyEndExclusive = i;
			continue;
		}

		// Forward-compatibility: trailing lines in a shape the format defines
		// but this version does not recognize are still treated as structured.
		// See UNKNOWN_KV_LINE_RE / UNKNOWN_STAMPED_LINE_RE for why these two
		// shapes and not "any bracket-leading line".
		//
		// CARRIED, not just skipped. data-format.md's Migration section asks
		// this version to "ignore" a line it does not understand, and absorbing
		// it into the trailing block then dropping it on the next write is not
		// ignoring it, it is deleting it. Executed: a body ending `[retry=3]`
		// came back without that line and the next lifecycle write removed it
		// from the file, with no Notice anywhere. The same shape is how a NEWER
		// version's fields arrive here, so the version that does not understand
		// them is exactly the one that must not throw them away.
		if (isUnknownStructuredLine(line)) {
			unknownLines.push(unescapeMarkerText(line));
			bodyEndExclusive = i;
			continue;
		}

		break;
	}

	const bodyLines = lines.slice(0, bodyEndExclusive);
	const bodyRaw = bodyLines.join('\n');
	const body = unescapeBody(bodyRaw.trim());
	// The walk ran bottom-up, so these came off the file in reverse.
	unknownLines.reverse();

	replies.reverse();
	// Stable-sort by timestamp so a thread reads oldest-first even if its
	// marker was rewritten with replies out of order (e.g. an assistant
	// regenerating the block). Array.sort is stable, so replies that share a
	// stamp keep their file order as the tiebreak. ISO stamps compare correctly
	// with a plain lexical compare, and a legacy date-only stamp sorts at the
	// start of its day relative to same-day timestamped replies.
	replies.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

	return {
		body,
		id,
		date,
		author,
		anchor,
		replies,
		addressed,
		resolution,
		unknownLines,
	};
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
			unknownLines: tail.unknownLines,
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
	// The same refusal scanMarkers makes, for the same reason. Without it the
	// two disagree about the same document: parseAll would report the marker
	// nested INSIDE this match while parseAt reported the merged one, and the
	// edit composer (its only caller) would rewrite the merged range.
	if (firstUnescaped(inner, NESTED_OPENER_RE) >= 0) return undefined;
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
		unknownLines: tail.unknownLines,
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
	// Trailing lines this version does not understand, carried through from the
	// parse so a write does not delete them. See the walk's unknown-line branch.
	unknownLines?: readonly string[];
}

// A category that MARKER_RE cannot match makes the whole marker invisible: it
// stays in the file as text the parser never finds, so the comment is gone from
// the panel, from the editor and from every count, while its words sit in the
// document. `data.json` is the way in, since the settings UI enforces the
// stricter isValidCategoryName; a hand edit or a synced file is not obliged to.
//
// The test is MARKER_RE's own category group and NOT isValidCategoryName, which
// is stricter than the grammar (it also forbids double dashes, trailing dashes
// and the five reserved keywords). A hand-authored `annoteca/my--topic` marker
// parses today, so validating against the stricter rule would rewrite it to
// `uncategorized` the first time someone replied to it: destroying a working
// category to prevent a problem it does not have.
//
// `uncategorized` and not the raw value, because serialize()'s return is
// spliced into the document. Returning the bare category, as one review round
// proposed, replaces the entire marker with that string and deletes the comment
// outright.
function serializableCategory(category: string): string {
	return isSerializableCategory(category) ? category : 'uncategorized';
}

export function serialize(c: SerializeInput): string {
	const category = serializableCategory(c.category);
	// Every free-text field is escaped on the way out and unescaped on the way
	// back in, so a body, note, anchor or reply holding `-->` round-trips
	// instead of closing the marker early. See escapeTerminator.
	const body = escapeBody(c.body);
	// Vetted, not trusted. These reach serialize as plain strings, and a caller
	// that put body text in here would write it into the trailing block, where
	// the next parse absorbs it: the marker would grow a line the user never
	// typed and lose one they did. The test is the walk's own, so a line only
	// survives the round trip if it comes back out as the same unknown line.
	const unknown = (c.unknownLines ?? [])
		.map((line) => escapeInline(line))
		.filter(isUnknownStructuredLine);
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
		unknown.length === 0 &&
		!bodyMultiline
	) {
		return `<!-- annoteca/${category}: ${body} -->`;
	}

	const lines: string[] = [];
	lines.push(`<!-- annoteca/${category}: ${body}`);
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
			const original = escapeMarkerText(c.addressed.original);
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
	// Last in the block, and their position among themselves is all that is
	// preserved. Where a line sat relative to the lines this version DOES
	// understand is not recoverable: the walk classifies by shape, not by
	// position, so it cannot say whether `[retry=3]` belonged above or below the
	// replies. Keeping the line is the point; keeping its neighbours is not
	// something the format ever promised.
	for (const line of unknown) lines.push(line);
	lines.push(TERMINATOR);
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
// words and different fixes, and because two of them describe a document that
// still parses, which the original reason line does not cover.
//
// They are also acted on differently, which is the reason the distinction has
// to survive: 'unclosed-opener' blocks a write that would REMOVE a marker below
// it, 'possible-merge' blocks one that would remove the marker it names, and
// 'malformed' blocks nothing, because a marker whose category cannot be read
// closes itself and removing something else cannot make it worse. See
// findRemovalBlocker.
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
// The false positive this used to have (a body quoting an opener) is gone:
// serialize escapes `<!--` now, so an unescaped one really is an opener and an
// escaped one really is prose. The escape run is checked rather than the raw
// match for exactly that reason.
const OPENER_ANYWHERE_RE = /<!--\s*annoteca\/[a-z0-9-]+:/gi;

// Reported when an opener has no `-->` of its own, and when a marker's `-->`
// may not be its own.
//
// This used to be the whole answer to the merge failure, because parsing was
// deliberately left alone: an unclosed opener paired with the next marker's
// terminator, and the merged comment was perfectly well-formed, so nothing but
// counting openers against markers could see it. scanMarkers refuses that
// pairing now, which changes what is left to report.
//
//   1. An unclosed ANNOTECA opener is no longer inside anything. scanMarkers
//      resumes at the nested opener, so the marker below it parses on its own
//      and the stray opener stands alone: it is reported as 'unclosed-opener'
//      wherever it sits. The old "opener inside a valid marker" branch is gone
//      with the behaviour that produced it.
//   2. A GENERIC `<!--` inside a marker is still a suspected merge, and this is
//      the half parsing does NOT change. `<!-- annoteca/todo: text` followed by
//      any ordinary HTML comment pairs with THAT comment's `-->`, swallowing the
//      prose between them exactly as two annoteca markers used to. Refusing to
//      pair there would break every existing marker whose body merely mentions
//      an HTML comment, which is a far commoner shape than a stray opener, so
//      this reports instead and comment-service refuses the destructive verbs
//      on the strength of the report.
//
// Reporting stays the conservative half: this never rewrites, so a false
// positive costs a line in a report, while a false negative costs a paragraph
// that has silently vanished from reading view.
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
		if (backslashRunBefore(content, match.index) > 0) continue;
		reported.add(match.index);
		out.push({
			start: match.index,
			excerpt: excerptAt(match.index),
			reason: 'Marker did not match the canonical Annoteca format.',
			kind: 'malformed',
		});
	}

	OPENER_ANYWHERE_RE.lastIndex = 0;
	while ((match = OPENER_ANYWHERE_RE.exec(content)) !== null) {
		const at = match.index;
		if (valid.has(at) || reported.has(at)) continue;
		if (backslashRunBefore(content, at) > 0) continue;
		out.push({
			start: at,
			excerpt: excerptAt(at),
			reason: 'Marker opener has no closing `-->`.',
			kind: 'unclosed-opener',
		});
	}

	for (const m of markers) {
		if (firstUnescaped(m.innerContent, HTML_OPENER_RE) < 0) continue;
		out.push({
			start: m.start,
			excerpt: excerptAt(m.start),
			reason: 'This marker contains an unescaped `<!--`, so the `-->` closing it may belong to that comment instead. Text between them would be hidden. Check for a missing `-->`.',
			kind: 'possible-merge',
		});
	}

	out.sort((a, b) => a.start - b.start);
	return out;
}

// The spans an unclosed opener hides, as absolute offsets.
//
// A rewriting pass has to know about these because scanMarkers no longer does.
// While an unclosed opener merged with the next marker's terminator, the whole
// region WAS a marker, so anything asking scanMarkers what not to touch got
// this span for free. Refusing that pairing takes the span off that list, and a
// bulk conversion that rewrites inside it edits text sitting inside an HTML
// comment: invisible in reading view, so the user cannot see what changed.
//
// The extent is the opener to the end of the next literal `-->`, which is what
// a markdown renderer hides, or to the end of the document when there is none.
// That is deliberately more than the plugin's own parse would claim: this
// answers "what is currently invisible", not "what is a marker".
export function unclosedOpenerRanges(content: string): MarkerRange[] {
	const out: MarkerRange[] = [];
	for (const finding of findMalformedMarkers(content)) {
		if (finding.kind !== 'unclosed-opener') continue;
		const closes = content.indexOf(TERMINATOR, finding.start);
		out.push({
			start: finding.start,
			end: closes === -1 ? content.length : closes + TERMINATOR.length,
		});
	}
	return out;
}

// The finding that must stop a write from REMOVING this marker, or undefined
// when there is nothing in the way.
//
// Removal is the one operation that makes a damaged document worse rather than
// merely leaving it damaged. An unclosed opener above the marker means the
// marker's own `-->` is the terminator currently ending that hidden region, so
// deleting the marker extends the region: more of the user's prose disappears
// from reading view, and nothing says why. A suspected merge on the marker
// itself is the same hazard from the other side, since the range being removed
// may not be the range the user thinks it is.
//
// Openers BELOW the marker are not a blocker. Their region is terminated by
// something else, and removing a marker above them cannot change that.
//
// Refusing rather than repairing is deliberate: this cannot know which `-->`
// the user meant to write, and a wrong guess edits their document. The action is
// repeatable once the marker is closed; prose removed by a write is not.
// Takes the whole set of ranges a write is about to remove rather than one at a
// time, so a bulk cleanup scans the document once and asks the same question
// each single-marker verb asks. A second copy of the predicate for the bulk case
// is the drift this file keeps warning about.
export function findRemovalBlocker(
	content: string,
	markers: readonly MarkerRange[],
): MalformedMarker | undefined {
	if (markers.length === 0) return undefined;
	const findings = findMalformedMarkers(content);
	// 'malformed' is not a blocker. It means a marker whose category this
	// version cannot read, which closes itself: removing something else in the
	// note cannot make it worse.
	return findings.find((f) =>
		f.kind === 'unclosed-opener'
			? markers.some((m) => f.start < m.start)
			: f.kind === 'possible-merge'
				? markers.some((m) => f.start === m.start)
				: false,
	);
}
