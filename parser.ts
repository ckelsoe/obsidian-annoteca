// Parser and serializer for the Annoteca marker format. No Obsidian dependency.
// The format contract this implements is in dev-docs/annoteca/data-format.md.

import type { Comment, Reply, Resolution } from "./types";

// Canonical regex from data-format.md "greppable regex" section. Matches the
// entire marker, opening through closing. The category is captured; the rest of
// the inner content is captured for line-level parsing.
const MARKER_RE = /<!--\s*annoteca\/([a-z][a-z0-9-]*)\s*:([\s\S]*?)-->/g;

// Permissive trailing-line patterns. The strict category-name rules live in
// categories.ts. Authors and dates use lowercase ASCII letters/digits/dashes,
// constrained to 32 chars to match the spec's metadata limits.
const ID_LINE_RE = /^\s*\[id=([a-z0-9]{1,32})\]\s*$/;
const DATE_LINE_RE = /^\s*\[date=(\d{4}-\d{2}-\d{2})\]\s*$/;
const AUTHOR_LINE_RE = /^\s*\[author=([a-z0-9-]{1,32})\]\s*$/;
const REPLY_LINE_RE = /^\s*\[reply\s+([a-z0-9-]{1,32})\s+(\d{4}-\d{2}-\d{2})\]:\s?([\s\S]*)$/;
const RESOLVED_LINE_RE = /^\s*\[resolved\s+([a-z0-9-]{1,32})\s+(\d{4}-\d{2}-\d{2})\]:\s?([\s\S]*)$/;

const ID_BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

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
	replies: Reply[];
	resolution: Resolution | undefined;
}

function parseInnerContent(inner: string): ParsedTail {
	const lines = inner.split("\n");
	let id: string | undefined;
	let date: string | undefined;
	let author: string | undefined;
	const replies: Reply[] = [];
	let resolution: Resolution | undefined;

	let bodyEndExclusive = lines.length;

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;

		if (line.trim() === "") {
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

		const replyMatch = REPLY_LINE_RE.exec(line);
		if (replyMatch && replyMatch[1] !== undefined && replyMatch[2] !== undefined) {
			replies.push({
				author: replyMatch[1],
				date: replyMatch[2],
				body: replyMatch[3] ?? "",
			});
			bodyEndExclusive = i;
			continue;
		}

		const resolvedMatch = RESOLVED_LINE_RE.exec(line);
		if (resolvedMatch && resolvedMatch[1] !== undefined && resolvedMatch[2] !== undefined) {
			if (!resolution) {
				resolution = {
					author: resolvedMatch[1],
					date: resolvedMatch[2],
					note: resolvedMatch[3] ?? "",
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
	const bodyRaw = bodyLines.join("\n");
	const body = bodyRaw.trim();

	replies.reverse();

	return { body, id, date, author, replies, resolution };
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
			replies: tail.replies,
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
		replies: tail.replies,
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
	replies?: readonly Reply[];
	resolution?: Resolution;
}

export function serialize(c: SerializeInput): string {
	const hasMetadata = c.id !== undefined || c.date !== undefined || c.author !== undefined;
	const hasReplies = (c.replies?.length ?? 0) > 0;
	const hasResolution = c.resolution !== undefined;
	const bodyMultiline = c.body.includes("\n");

	if (!hasMetadata && !hasReplies && !hasResolution && !bodyMultiline) {
		return `<!-- annoteca/${c.category}: ${c.body} -->`;
	}

	const lines: string[] = [];
	lines.push(`<!-- annoteca/${c.category}: ${c.body}`);
	if (c.id !== undefined) lines.push(`[id=${c.id}]`);
	if (c.date !== undefined) lines.push(`[date=${c.date}]`);
	if (c.author !== undefined) lines.push(`[author=${c.author}]`);
	for (const r of c.replies ?? []) {
		lines.push(`[reply ${r.author} ${r.date}]: ${r.body}`);
	}
	if (c.resolution) {
		const note = c.resolution.note.length > 0 ? ` ${c.resolution.note}` : "";
		lines.push(`[resolved ${c.resolution.author} ${c.resolution.date}]:${note}`);
	}
	lines.push(`-->`);
	return lines.join("\n");
}

// 8-character lowercase base36 ID. Uses Math.random so it works in the
// Obsidian renderer process. Collision probability ~1 in 2.8 trillion;
// callers retry against the vault-wide index on collision.
export function generateId(): string {
	let id = "";
	for (let i = 0; i < 8; i++) {
		const idx = Math.floor(Math.random() * ID_BASE36_ALPHABET.length);
		id += ID_BASE36_ALPHABET.charAt(idx);
	}
	return id;
}

export function todayISO(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export interface MalformedMarker {
	start: number;
	excerpt: string;
	reason: string;
}

const OPENING_TOKEN_RE = /<!--\s*annoteca\/(?![a-z][a-z0-9-]*\s*:)[^>]{0,120}-->|<!--\s*annoteca\/[^a-z][^>]*-->/g;

export function findMalformedMarkers(content: string): MalformedMarker[] {
	const valid = new Set<number>();
	for (const m of scanMarkers(content)) valid.add(m.start);

	const out: MalformedMarker[] = [];
	OPENING_TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = OPENING_TOKEN_RE.exec(content)) !== null) {
		if (valid.has(match.index)) continue;
		const excerpt = content.slice(match.index, Math.min(content.length, match.index + 120));
		out.push({
			start: match.index,
			excerpt,
			reason: "Marker did not match the canonical Annoteca format.",
		});
	}
	return out;
}
