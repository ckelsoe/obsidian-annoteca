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
// Anchor value is permissive: anything but `]` or a line break. Length is
// capped to 80 visible chars + an optional single ellipsis character to
// indicate truncation (per data-format.md). Longer values are still parsed —
// forward-compat — but the cap is enforced at serialize time.
const ANCHOR_LINE_RE = /^\s*\[anchor=([^\]\r\n]{1,200})\]\s*$/;
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

interface RawMarker {
	start: number;
	end: number;
	category: string;
	innerContent: string;
}

function scanMarkers(content: string): RawMarker[] {
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

function parseInnerContent(inner: string): ParsedTail {
	// Pull the annoteca-original fence out first (F-271). It is the only
	// multi-line element in the trailing block; removing it lets the backward
	// line-walk below treat [addressed ...] as an ordinary single structured
	// line. The fence always lives directly after the [addressed ...] line, so
	// its content unambiguously belongs to the (at most one) addressed note.
	// ADJACENCY IS ENFORCED, not merely assumed. Lifting out any block that
	// happens to be tagged annoteca-original deletes it from the file, because
	// originalText is discarded when there is no addressed note to hang it on.
	// A body that documents the format by showing a fence is a normal thing to
	// write, and the exported skill describes the fence, so assistants write
	// them too. Only a fence sitting DIRECTLY after the [addressed ...] line is
	// the addressed note's original; everything else stays body text.
	let originalText: string | undefined;
	let stripped = inner;
	for (const fenceMatch of inner.matchAll(ORIGINAL_FENCE_RE)) {
		const content = fenceMatch[2];
		if (content === undefined || fenceMatch.index === undefined) continue;
		const before = inner.slice(0, fenceMatch.index).replace(/\r?\n$/, '');
		const precedingLine = before.slice(before.lastIndexOf('\n') + 1);
		if (!ADDRESSED_LINE_RE.test(precedingLine)) continue;
		originalText = unescapeTerminator(content);
		stripped =
			before + inner.slice(fenceMatch.index + fenceMatch[0].length);
		break;
	}

	const lines = stripped.split('\n');
	let id: string | undefined;
	let date: string | undefined;
	let author: string | undefined;
	let anchor: AnchorText | undefined;
	const replies: Reply[] = [];
	let addressed: Addressed | undefined;
	let resolution: Resolution | undefined;

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
			id = idMatch[1];
			bodyEndExclusive = i;
			continue;
		}

		const dateMatch = DATE_LINE_RE.exec(line);
		if (dateMatch && dateMatch[1] !== undefined) {
			date = dateMatch[1];
			bodyEndExclusive = i;
			continue;
		}

		const authorMatch = AUTHOR_LINE_RE.exec(line);
		if (authorMatch && authorMatch[1] !== undefined) {
			author = authorMatch[1];
			bodyEndExclusive = i;
			continue;
		}

		const anchorMatch = ANCHOR_LINE_RE.exec(line);
		if (anchorMatch && anchorMatch[1] !== undefined) {
			const raw = unescapeTerminator(anchorMatch[1]);
			const truncated = raw.includes(ANCHOR_ELLIPSIS);
			anchor = { text: raw, truncated };
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
			if (!addressed) {
				addressed = {
					author: addressedMatch[1],
					date: addressedMatch[2],
					note: unescapeTerminator(addressedMatch[3] ?? ''),
					original: originalText,
				};
			}
			bodyEndExclusive = i;
			continue;
		}

		const resolvedMatch = RESOLVED_LINE_RE.exec(line);
		if (
			resolvedMatch &&
			resolvedMatch[1] !== undefined &&
			resolvedMatch[2] !== undefined
		) {
			if (!resolution) {
				resolution = {
					author: resolvedMatch[1],
					date: resolvedMatch[2],
					note: unescapeTerminator(resolvedMatch[3] ?? ''),
				};
			}
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
	if (c.author !== undefined) lines.push(`[author=${c.author}]`);
	if (c.anchor !== undefined)
		lines.push(`[anchor=${escapeInline(c.anchor.text)}]`);
	for (const r of c.replies ?? []) {
		lines.push(`[reply ${r.author} ${r.date}]: ${escapeInline(r.body)}`);
	}
	if (c.addressed) {
		const rawNote = escapeInline(c.addressed.note);
		const note = rawNote.length > 0 ? ` ${rawNote}` : '';
		lines.push(
			`[addressed ${c.addressed.author} ${c.addressed.date}]:${note}`,
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
			`[resolved ${c.resolution.author} ${c.resolution.date}]:${note}`,
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
	// Mid-truncate: keep both ends searchable. Ellipsis itself counts toward
	// the cap so the stored value never exceeds ANCHOR_MAX_CHARS.
	const keep = ANCHOR_MAX_CHARS - 1; // 1 char reserved for the ellipsis
	const headLen = Math.ceil(keep / 2);
	const tailLen = keep - headLen;
	const head = cleaned.slice(0, headLen).trimEnd();
	const tail = cleaned.slice(cleaned.length - tailLen).trimStart();
	return { text: `${head}${ANCHOR_ELLIPSIS}${tail}`, truncated: true };
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

export interface MalformedMarker {
	start: number;
	excerpt: string;
	reason: string;
}

const OPENING_TOKEN_RE =
	/<!--\s*annoteca\/(?![a-z][a-z0-9-]*\s*:)[^>]{0,120}-->|<!--\s*annoteca\/[^a-z][^>]*-->/g;

export function findMalformedMarkers(content: string): MalformedMarker[] {
	const valid = new Set<number>();
	for (const m of scanMarkers(content)) valid.add(m.start);

	const out: MalformedMarker[] = [];
	OPENING_TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = OPENING_TOKEN_RE.exec(content)) !== null) {
		if (valid.has(match.index)) continue;
		const excerpt = content.slice(
			match.index,
			Math.min(content.length, match.index + 120),
		);
		out.push({
			start: match.index,
			excerpt,
			reason: 'Marker did not match the canonical Annoteca format.',
		});
	}
	return out;
}
