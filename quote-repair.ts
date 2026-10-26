// Repair for an HTML comment copied unescaped into a comment's original text.
//
// When an assistant addresses a comment by replacing its passage, it keeps the
// old text in an `annoteca-original` fence so Reject can put it back. The old
// text can hold an HTML comment of its own, such as a citation
// `<!-- c:09-82 -->`. The format escapes those (`\<!--`, `--\>`), and the
// plugin's own writer does, but an assistant writing the file directly can
// copy one in as it is. Two shapes follow:
//
//   1. UNCLOSED: the quote has its `-->`. The marker ends there, in the middle
//      of its fence. The rest of the fence, the fence's closing line and the
//      marker's real `-->` show in the note as text, and the comment loses its
//      original, so Reject has nothing to restore.
//   2. CLOSED: only the quote's `<!--` is in the fence (or its `-->` was
//      escaped). The marker reads, but an unescaped `<!--` inside it is the
//      shape Validate reports as a possible merge, and the destructive verbs
//      refuse to touch it.
//
// Both are repaired by escaping the quote inside the fence, which is what the
// writer would have stored: the original reads back byte for byte. A shape 1
// repair is kept only when the marker then reads to the `-->` after the fence
// with its original intact, so text that merely looks like this is left alone.
//
// Pure: no Obsidian dependency.

import type { ImportResult } from './imports';
import { hasRepairableNesting, repairNestedMarkers } from './nested-repair';
import {
	backslashRunBefore,
	escapeMarkerText,
	findMalformedMarkers,
	findOriginalFences,
	parseAll,
	scanMarkers,
} from './parser';

const FENCE_INFO = 'annoteca-original';
const TERMINATOR = '-->';

interface Edit {
	from: number;
	to: number;
	text: string;
}

// Fill in the escapes a partly escaped fence is missing: an opener with no
// backslash gets one, and one that has its backslash is left as it is. For
// shape 2, where the `-->` escape shows the writer knew the rule, so a
// backslash already there is taken as that escape rather than as text.
function escapeQuotes(text: string): string {
	const openers = text.replace(/<!--/g, (match: string, at: number) =>
		backslashRunBefore(text, at) === 0 ? `\\${match}` : match,
	);
	// `--\>` does not match, so every `-->` left is a live terminator.
	return openers.replace(/-->/g, '--\\>');
}

function hasUnescapedOpener(text: string): boolean {
	for (
		let at = text.indexOf('<!--');
		at !== -1;
		at = text.indexOf('<!--', at + 1)
	)
		if (backslashRunBefore(text, at) === 0) return true;
	return false;
}

function backtickRun(text: string, at: number): number {
	let i = at;
	while (text.charAt(i) === '`') i += 1;
	return i - at;
}

// Whether the line starting at `at` is a fence line of exactly `run`
// backticks, then blanks, then a line break or the end.
function closesFence(text: string, at: number, run: number): boolean {
	if (backtickRun(text, at) !== run) return false;
	let i = at + run;
	while (text.charAt(i) === ' ' || text.charAt(i) === '\t') i += 1;
	return (
		i === text.length || text.charAt(i) === '\n' || text.charAt(i) === '\r'
	);
}

// The line starts in `text`, in order.
function lineStarts(text: string): number[] {
	const out = [0];
	for (
		let at = text.indexOf('\n');
		at !== -1;
		at = text.indexOf('\n', at + 1)
	)
		out.push(at + 1);
	return out;
}

// The repairs the note may need, one per damaged comment, in order. Each is
// only a candidate until `applied` checks it.
function* candidateEdits(content: string): Generator<Edit> {
	for (const m of scanMarkers(content)) {
		const inner = m.innerContent;
		const innerStart = m.end - TERMINATOR.length - inner.length;
		if (content.slice(innerStart, m.end - TERMINATOR.length) !== inner)
			continue;
		if (!hasUnescapedOpener(inner)) continue;

		// Shape 2: a closed fence holding an unescaped quote.
		const fences = findOriginalFences(inner);
		for (const f of fences) {
			if (!hasUnescapedOpener(f.content)) continue;
			const bodyStart = inner.indexOf('\n', f.start) + 1;
			if (
				inner.slice(bodyStart, bodyStart + f.content.length) !==
				f.content
			)
				continue;
			yield {
				from: innerStart + bodyStart,
				to: innerStart + bodyStart + f.content.length,
				text: escapeQuotes(f.content),
			};
		}

		// Shape 1: the last fence opener in the marker has no closing line
		// inside it, and its quote's `-->` is where the marker stopped.
		const consumed = new Set(fences.map((f) => f.start));
		let open: { at: number; run: number } | undefined;
		for (const p of lineStarts(inner)) {
			const run = backtickRun(inner, p);
			if (
				run >= 3 &&
				inner.startsWith(FENCE_INFO, p + run) &&
				!consumed.has(p)
			)
				open = { at: p, run };
		}
		if (open === undefined) continue;
		const nl = inner.indexOf('\n', open.at);
		if (nl === -1) continue;
		const bodyStart = innerStart + nl + 1;
		// The fence's closing line, after the marker's early end.
		let close = -1;
		for (
			let nlAt = content.indexOf('\n', m.end - 1);
			nlAt !== -1;
			nlAt = content.indexOf('\n', nlAt + 1)
		) {
			if (closesFence(content, nlAt + 1, open.run)) {
				close = nlAt + 1;
				break;
			}
		}
		if (close === -1) continue;
		const between = content.slice(m.end, close);
		// Another comment of Annoteca's in the way: not this shape.
		if (/<!--\s*\/?annoteca/i.test(between)) continue;
		// After the closing line, only whitespace, then the marker's own `-->`.
		let after = close + open.run;
		while (/\s/.test(content.charAt(after))) after += 1;
		if (!content.startsWith(TERMINATOR, after)) continue;
		let bodyEnd = close - 1;
		if (content.charAt(bodyEnd - 1) === '\r') bodyEnd -= 1;
		if (bodyEnd < bodyStart) continue;
		// A live `-->` in it means nothing in it was escaped, so it is the
		// verbatim text, and it gets the writer's whole escape: a backslash
		// already in it is text, and keeps its own escape.
		yield {
			from: bodyStart,
			to: bodyEnd,
			text: escapeMarkerText(content.slice(bodyStart, bodyEnd)),
		};
	}
}

// The first candidate that checks out, applied, or undefined.
function repairOne(content: string): string | undefined {
	for (const edit of candidateEdits(content)) {
		const next = applied(content, edit);
		if (next !== undefined) return next;
	}
	return undefined;
}

// Apply `edit`, and keep it only when the note is strictly less damaged, no
// comment is lost, and the comment it was for reads with its original.
function applied(content: string, edit: Edit): string | undefined {
	const updated =
		content.slice(0, edit.from) + edit.text + content.slice(edit.to);
	if (
		findMalformedMarkers(updated).length >=
		findMalformedMarkers(content).length
	)
		return undefined;
	const before = parseAll(content);
	const after = parseAll(updated);
	if (after.length < before.length) return undefined;
	const holder = after.find(
		(c) => c.marker.start < edit.from && c.marker.end > edit.to,
	);
	if (holder?.addressed?.original === undefined) return undefined;
	return updated;
}

// Escape every such quote. `converted` is how many comments were repaired.
export function repairQuotedOriginals(content: string): ImportResult {
	let updated = content;
	let converted = 0;
	// Each repair removes at least one unescaped `<!--`, so there are never
	// more repairs than those. The bound only guards against a loop.
	const bound = content.split('<!--').length;
	for (let step = 0; step < bound; step++) {
		const next = repairOne(updated);
		if (next === undefined) break;
		updated = next;
		converted += 1;
	}
	return { updated, converted };
}

export function hasRepairableQuote(content: string): boolean {
	return repairOne(content) !== undefined;
}

// What "Repair comments written inside other comments" runs: the quotes
// first, since an unescaped quote can make a marker look like it holds
// another one, then the nested comments.
export function repairComments(content: string): ImportResult {
	const quotes = repairQuotedOriginals(content);
	const nested = repairNestedMarkers(quotes.updated);
	return {
		updated: nested.updated,
		converted: quotes.converted + nested.converted,
	};
}

export function hasRepairableDamage(content: string): boolean {
	return hasRepairableQuote(content) || hasRepairableNesting(content);
}
