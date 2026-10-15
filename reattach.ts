// Anchoring hardening, part C: find a comment's text again.
//
// A comment remembers the text it was made on as its anchor quote (up to 80
// characters, long ones kept as "head…tail"). When the marker has lost that
// text (the passage was rewritten elsewhere, the marker was restored after
// being dropped, or a closer went missing) the quote is how the comment finds
// its passage again: exactly first, then ignoring differences in spacing, then
// ignoring case too. Matches inside other comments' markers, the comment store
// or the note's properties do not count. Of several, the one nearest where the
// comment was is taken.
//
// Pure: no Obsidian dependency.

import { forbiddenRanges } from './comment-service';

export interface Passage {
	readonly start: number;
	readonly end: number;
}

// `text` with whitespace runs collapsed to one space (and, when `fold`,
// lower-cased), with each kept character's offset in `text`.
function normalized(text: string, fold: boolean): { s: string; map: number[] } {
	let s = '';
	const map: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (/\s/.test(ch)) {
			if (s.endsWith(' ')) continue;
			s += ' ';
		} else s += fold ? ch.toLowerCase() : ch;
		map.push(i);
	}
	return { s, map };
}

function allMatches(hay: string, needle: string): number[] {
	const out: number[] = [];
	if (needle === '') return out;
	for (
		let at = hay.indexOf(needle);
		at !== -1;
		at = hay.indexOf(needle, at + 1)
	)
		out.push(at);
	return out;
}

// Matches of `quote` in `hay`, as [start, end) in `hay`. A "head…tail" quote
// matches the head with the tail a short reach after it.
function matchSpans(hay: string, quote: string): [number, number][] {
	const ellipsis = quote.indexOf('…');
	if (ellipsis === -1)
		return allMatches(hay, quote).map((at) => [at, at + quote.length]);
	const head = quote.slice(0, ellipsis).trimEnd();
	const tail = quote.slice(ellipsis + 1).trimStart();
	if (head === '' || tail === '') return [];
	const out: [number, number][] = [];
	for (const at of allMatches(hay, head)) {
		const t = hay.indexOf(tail, at + head.length);
		if (t !== -1 && t - at < 2000) out.push([at, t + tail.length]);
	}
	return out;
}

// Every place `quote` occurs in `content` under one level of tolerance, as
// source ranges.
function matchesAt(
	content: string,
	quote: string,
	level: 'exact' | 'spacing' | 'case',
): Passage[] {
	if (level === 'exact')
		return matchSpans(content, quote).map(([start, end]) => ({
			start,
			end,
		}));
	const fold = level === 'case';
	const hay = normalized(content, fold);
	const needle = normalized(quote, fold).s.trim();
	const out: Passage[] = [];
	for (const [a, b] of matchSpans(hay.s, needle)) {
		const start = hay.map[a];
		const last = hay.map[b - 1];
		if (start !== undefined && last !== undefined)
			out.push({ start, end: last + 1 });
	}
	return out;
}

// The passage `quote` names in `content`, nearest `near`, or undefined.
export function findPassage(
	content: string,
	quote: string | undefined,
	near: number,
): Passage | undefined {
	if (quote === undefined || quote.trim() === '') return undefined;
	const blocked = forbiddenRanges(content);
	const clear = (p: Passage): boolean =>
		!blocked.some((f) => f.start < p.end && f.end > p.start);
	for (const level of ['exact', 'spacing', 'case'] as const) {
		const found = matchesAt(content, quote, level).filter(clear);
		if (found.length === 0) continue;
		return found.reduce((best, p) =>
			Math.abs(p.start - near) < Math.abs(best.start - near) ? p : best,
		);
	}
	return undefined;
}
