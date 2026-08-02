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

// The lossless-original fence (F-271): a fenced block tagged annoteca-original
// inside the [addressed ...] note, holding the verbatim pre-edit text. Matched
// as whole lines (m flag); group 1 is the verbatim original. Tolerates CRLF and
// trailing whitespace on the fence lines.
const ORIGINAL_FENCE_RE =
	/^```annoteca-original[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;

// Maximum visible characters in an anchor value before mid-truncation kicks
// in. 80 strikes the balance between "disambiguate the commented words" and
// "keep the marker file compact." Mirrors data-format.md.
export const ANCHOR_MAX_CHARS = 80;
const ANCHOR_ELLIPSIS = '…';

const ID_BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

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
	let originalText: string | undefined;
	let stripped = inner;
	const fenceMatch = ORIGINAL_FENCE_RE.exec(inner);
	if (
		fenceMatch &&
		fenceMatch[1] !== undefined &&
		fenceMatch.index !== undefined
	) {
		originalText = fenceMatch[1];
		const before = inner.slice(0, fenceMatch.index).replace(/\r?\n$/, '');
		const after = inner.slice(fenceMatch.index + fenceMatch[0].length);
		stripped = before + after;
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
			const raw = anchorMatch[1];
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
				body: replyMatch[3] ?? '',
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
					note: addressedMatch[3] ?? '',
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
					note: resolvedMatch[3] ?? '',
				};
			}
			bodyEndExclusive = i;
			continue;
		}

		// Forward-compatibility: bracket-shaped trailing lines we do not
		// recognize are still treated as structured (per data-format.md
		// Migration: ignore unknown structured trailing lines rather than
		// failing). They never re-emerge in serialize() because the Comment
		// shape does not carry them.
		if (/^\s*\[[^\]]+\][^\n]*$/.test(line)) {
			bodyEndExclusive = i;
			continue;
		}

		break;
	}

	const bodyLines = lines.slice(0, bodyEndExclusive);
	const bodyRaw = bodyLines.join('\n');
	const body = bodyRaw.trim();

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
	const hasMetadata =
		c.id !== undefined ||
		c.date !== undefined ||
		c.author !== undefined ||
		c.anchor !== undefined;
	const hasReplies = (c.replies?.length ?? 0) > 0;
	const hasAddressed = c.addressed !== undefined;
	const hasResolution = c.resolution !== undefined;
	const bodyMultiline = c.body.includes('\n');

	if (
		!hasMetadata &&
		!hasReplies &&
		!hasAddressed &&
		!hasResolution &&
		!bodyMultiline
	) {
		return `<!-- annoteca/${c.category}: ${c.body} -->`;
	}

	const lines: string[] = [];
	lines.push(`<!-- annoteca/${c.category}: ${c.body}`);
	if (c.id !== undefined) lines.push(`[id=${c.id}]`);
	if (c.date !== undefined) lines.push(`[date=${c.date}]`);
	if (c.author !== undefined) lines.push(`[author=${c.author}]`);
	if (c.anchor !== undefined) lines.push(`[anchor=${c.anchor.text}]`);
	for (const r of c.replies ?? []) {
		lines.push(`[reply ${r.author} ${r.date}]: ${r.body}`);
	}
	if (c.addressed) {
		const note = c.addressed.note.length > 0 ? ` ${c.addressed.note}` : '';
		lines.push(
			`[addressed ${c.addressed.author} ${c.addressed.date}]:${note}`,
		);
		// F-271: the verbatim replaced text lives in a fenced annoteca-original
		// block directly after the [addressed ...] line. The fence is inert
		// markdown inside the HTML comment; the only sequence that would break
		// the wrapper is `-->`, which never appears in the captured prose.
		if (c.addressed.original !== undefined) {
			lines.push('```annoteca-original');
			lines.push(c.addressed.original);
			lines.push('```');
		}
	}
	if (c.resolution) {
		const note =
			c.resolution.note.length > 0 ? ` ${c.resolution.note}` : '';
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
