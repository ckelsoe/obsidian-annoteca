// Repair for notes where a comment was written inside another one.
//
// Before 1.27.2 the composer, restore, promote and the importer could write a
// marker or closer into the middle of an existing marker, closer, store entry
// or the note properties (see forbidden.ts, which now stops that). HTML
// comments do not nest, so the result is damage the note shows: the outer
// marker's opener is left with no `-->` and its id and thread lines appear as
// text, a store entry stops decoding, a closer stops pairing, or the
// properties stop being properties.
//
// Every one of those writes put the new marker or closer in as one piece, so
// the damage is undone by lifting that piece back out, which gives its host
// back the text it had (see withouts for the one space that can differ), and
// putting it where a new one goes now. A note in end-of-file storage whose
// store was rewritten after the damage needs one more step (rejoinStore). A
// lift is kept only when it makes the note strictly less damaged and loses
// no comment, so a note this cannot read is left exactly as it is.
//
// Only a piece the old writers could have put there is lifted: a marker with
// an id dated after `<!--` started being escaped, or a closer (see pieces).
// An older comment whose text quotes a marker is otherwise the same bytes,
// and lifting the quote would split that comment in two.
//
// Pure: no Obsidian dependency.

import { detectRangeIssues } from './diagnostics';
import { enclosingForbidden } from './forbidden';
import type { ImportResult } from './imports';
import {
	layoutMarker,
	markerRemovalSpan,
	planMarkerInsert,
	planSafeMarkerInsert,
} from './marker-placement';
import { findMalformedMarkers, parseAll, scanClosers } from './parser';
import { frontmatterEnd } from './range-placement';
import { decodeStoreEntry, parseStore, scanStoreEntries } from './store';

interface Piece {
	start: number;
	end: number;
	closer: boolean;
	// The separator the composer put after it inline: one space for a
	// comment on a selection, none for one at a bare cursor.
	inline: string;
}

// The day 1.14.0 shipped, from which every comment the plugin writes has
// its `<!--` escaped. A marker quoted inside an older comment's text was
// therefore written before this day, while every comment the bug nested was
// written by the plugin on or after it, stamped with when.
const OPENER_ESCAPE_SHIPPED = '2026-08-07';

// What can be lifted: a marker with an id dated on or after the escape
// shipped, and every closer (closers arrived in 1.20.0, after the escape, so
// no older text can quote one). A comment written before the escape whose
// text quotes a whole example marker, id line and all, is otherwise the same
// bytes as a nested comment, and lifting the quote would split that comment
// in two. A lean marker keeps its date in its store entry.
//
// A comment on a selection carries the anchor it was made from (inline, or in
// its store entry), which is how its separator is known.
function pieces(content: string): Piece[] {
	const markers = parseAll(content);
	const stored = new Map(
		parseStore(content).map((e) => [e.comment.id, e.comment]),
	);
	const out: Piece[] = [];
	for (const c of markers) {
		if (c.id === undefined) continue;
		const entry = stored.get(c.id);
		const date = c.date ?? entry?.date;
		if (date === undefined || date.slice(0, 10) < OPENER_ESCAPE_SHIPPED)
			continue;
		out.push({
			start: c.marker.start,
			end: c.marker.end,
			closer: false,
			inline:
				c.anchor !== undefined || entry?.anchor !== undefined
					? ' '
					: '',
		});
	}
	// Closers inside a marker too, which scanClosers leaves out by default:
	// a closer written into a marker's text is exactly what is being looked
	// for. One escaped as `\<!--` is quoted prose, never a closer.
	for (const k of scanClosers(content, []))
		if (content.charAt(k.start - 1) !== '\\')
			out.push({ start: k.start, end: k.end, closer: true, inline: '' });
	return out;
}

// Whether taking [from, to) out of `content` exactly undoes what the old
// composer wrote: the marker laid out by planMarkerInsert for a cursor at
// that spot, or on the next line (a marker for a paragraph's wrapped line
// went at the end of the line before).
function undoesInsert(
	content: string,
	from: number,
	to: number,
	p: Piece,
): boolean {
	const piece = content.slice(p.start, p.end);
	const before = content.slice(0, from) + content.slice(to);
	const nextLine = before.indexOf('\n', from);
	const cursors = nextLine === -1 ? [from] : [from, nextLine + 1];
	return cursors.some((c) => {
		const plan = planMarkerInsert(before, c, piece.includes('\n'));
		return (
			plan.at === from &&
			layoutMarker(plan, piece, p.inline) === content.slice(from, to)
		);
	});
}

// The note with `p` taken out, and where it came out, in the order to try.
// First whichever cut exactly undoes the old insert, so the host gets back
// every byte it had. Then the bare piece, which takes nothing that was there
// before and at worst leaves the spacing its placement added. Then the piece
// with that spacing (markerRemovalSpan), for a host where a stray line break
// matters, such as a JSON string in a store entry. A closer was inserted
// bare.
function withouts(content: string, p: Piece): { text: string; at: number }[] {
	const cut = (from: number, to: number) => ({
		text: content.slice(0, from) + content.slice(to),
		at: from,
	});
	if (p.closer) return [cut(p.start, p.end)];
	const removal = markerRemovalSpan(content, p.start, p.end);
	const spans: [number, number][] = [
		[p.start, p.end],
		[p.start, p.end + 1],
		[p.start - 1, p.end],
		[removal.from, removal.to],
	];
	const exact = spans.filter(
		([from, to]) =>
			from >= 0 &&
			to <= content.length &&
			undoesInsert(content, from, to, p),
	);
	// Two cuts can both fit, and the longer one is taken: the spacing the old
	// composer added went with the marker, and the note as written did
	// without it. `Note <m> ` + newline was a marker appended to the line
	// `Note ` with its space, not one at a cursor between two spaces; and
	// `- <m>` + newline + indent was a marker after a bullet, not one on a
	// line that ended at `-`.
	//
	// One shape stays ambiguous, and costs at most one space at the end of a
	// line. `word <m>` then a line break is either a cursor comment after
	// `word ` at the end of its line, or one appended to the line `word` from
	// a cursor at the start of the next. Likewise `word <m> ` then a line
	// break is either one appended to `word ` from the next line, or one at a
	// cursor between the two spaces of `word  `. The bytes are identical, so
	// the longer cut is taken: a cursor at the start of a line is what a
	// click puts there, while one between trailing spaces needs the arrow
	// keys (a click past the end of a line lands after the spaces). In that
	// rarer case one space is lost, and with it a hard line break (two
	// trailing spaces) in the comment's text.
	exact.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
	const ordered = [...exact, [p.start, p.end], [removal.from, removal.to]];
	const seen = new Set<string>();
	const out: { text: string; at: number }[] = [];
	for (const [from, to] of ordered as [number, number][]) {
		const key = `${from}:${to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(cut(from, to));
	}
	return out;
}

// Whether `p` sits inside something once it is out of the way. In a healthy
// note nothing does: that is the damage this repairs. Asked of each way out,
// because the spacing a placement added can hide it: a marker written before
// the properties left them starting on a blank line, where they are not
// properties until that line goes too.
function nested(content: string, p: Piece): boolean {
	return withouts(content, p).some(
		(out) => enclosingForbidden(out.text, out.at) !== undefined,
	);
}

// How damaged a note reads: stray and merged openers, store entries that no
// longer decode, range closers that lost their pair, and pieces sitting
// inside something. A lift has to lower this.
function damage(content: string): number {
	const malformed = findMalformedMarkers(content).filter(
		(f) => f.kind !== 'malformed',
	).length;
	const store = scanStoreEntries(content).filter(
		(e) => decodeStoreEntry(e.json) === undefined,
	).length;
	const ranges = detectRangeIssues(content, '').length;
	const inside = suspects(content).filter((p) => nested(content, p)).length;
	return malformed + store + ranges + inside;
}

// The pieces that could be inside something, found without a parse per
// piece, so a long healthy note costs one pass. A piece inside another
// marker, a closer or an open marker sits after that one's `<!--`, which
// nothing closes before the piece: the `<!--` pairs with nothing, or (a
// store entry) with the piece's own `-->`. A piece inside such an opener
// itself leaves the rest of it, up to its `-->`, unopened after the piece.
// A piece in the properties sits before their end, or, when it broke their
// `---` lines so they no longer read as properties, in the note's first
// block.
function suspects(content: string): Piece[] {
	const markers = parseAll(content).map((c) => c.marker);
	const stores = scanStoreEntries(content);
	const whole = [
		...markers,
		...scanClosers(content, markers),
		...stores,
	].sort((a, b) => a.start - b.start);
	const starts = new Set(whole.map((r) => r.start));
	const ends = new Set(whole.map((r) => r.end));
	// Every `<!--` and `-->` in a healthy note opens or closes one of these,
	// or sits inside one (a quoted, escaped one in a body). An ordinary HTML
	// comment of the user's is stray too, and then closes itself before any
	// piece that follows it. One sweep: delimiters and ranges both come in
	// document order.
	const opens: number[] = [];
	const closes: number[] = [];
	const strayOpen: number[] = [];
	const strayClose: number[] = [];
	let i = 0;
	const DELIMITER = /<!--|-->/g;
	let m: RegExpExecArray | null;
	while ((m = DELIMITER.exec(content)) !== null) {
		const at = m.index;
		const to = at + m[0].length;
		const open = m[0] === '<!--';
		(open ? opens : closes).push(at);
		while (i < whole.length && (whole[i]?.end ?? 0) < to) i++;
		const r = whole[i];
		const inside = r !== undefined && r.start <= at && to <= r.end;
		if (!inside && !starts.has(at) && !ends.has(to))
			(open ? strayOpen : strayClose).push(at);
	}
	// The stretch each stray delimiter leaves open: from a stray `<!--` to
	// the next `-->`, and back from a stray `-->` to the `<!--` before it.
	const after = (xs: number[], x: number): number => {
		let lo = 0;
		let hi = xs.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((xs[mid] ?? 0) < x) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	// Each stray stretch as the positions a piece edge may take in it, merged
	// into disjoint runs so a piece is looked up, not compared with every one.
	const runs = (spans: { from: number; to: number }[]) => {
		const merged: { from: number; to: number }[] = [];
		for (const sp of spans.sort((a, b) => a.from - b.from)) {
			const last = merged[merged.length - 1];
			if (last !== undefined && sp.from <= last.to + 1)
				last.to = Math.max(last.to, sp.to);
			else merged.push({ ...sp });
		}
		const froms = merged.map((r) => r.from);
		return (x: number): boolean => {
			const r = merged[after(froms, x + 1) - 1];
			return r !== undefined && x <= r.to;
		};
	};
	// A piece after a stray `<!--`, up to the next `-->`.
	const inOpen = runs(
		strayOpen.map((o) => ({
			from: o + 1,
			to: closes[after(closes, o)] ?? content.length,
		})),
	);
	// A piece before a stray `-->`, back to the `<!--` before it.
	const inClose = runs(
		strayClose.map((c) => ({
			from: opens[after(opens, c) - 1] ?? 0,
			to: c,
		})),
	);
	// A piece whose `-->` a store entry was read as ending at.
	const storeStartByEnd = new Map(stores.map((b) => [b.end, b.start]));
	const properties = frontmatterEnd(content);
	// Properties whose `---` line a piece broke no longer read as properties.
	// Such a piece sits on a fence line, three dashes in all on either side
	// of it (a selection's space after it aside) and nothing else on the line,
	// or opens the note on its own line
	// above the first fence.
	const brokenProperties =
		properties === 0 && /^(?:-{0,3}<!--|---)/.test(content);
	const onFence = (p: Piece): boolean => {
		const lineStart = content.lastIndexOf('\n', p.start - 1) + 1;
		const lead = content.slice(lineStart, p.start);
		const lineEnd = content.indexOf('\n', p.end);
		const rest = content.slice(p.end, lineEnd === -1 ? undefined : lineEnd);
		return (
			/^-{0,3}$/.test(lead) &&
			/^ ?-{0,3}[ \t]*$/.test(rest) &&
			lead.length + rest.trim().length === 3
		);
	};
	return pieces(content).filter(
		(p) =>
			inOpen(p.start) ||
			inClose(p.end) ||
			(storeStartByEnd.get(p.end) ?? p.start) < p.start ||
			p.start < properties ||
			(brokenProperties && (p.start === 0 || onFence(p))),
	);
}

function ids(content: string): Set<string> {
	const out = new Set<string>();
	for (const c of parseAll(content)) if (c.id !== undefined) out.add(c.id);
	for (const e of parseStore(content)) out.add(e.comment.id);
	return out;
}

// The note with `p` moved out of what it was in. A marker goes where a new
// one at that spot goes now: just before what it was in, or just after the
// properties. A closer ends its passage where the passage could have ended:
// after a marker or closer it was in, before a store entry.
function lift(
	content: string,
	p: Piece,
	out: { text: string; at: number },
): string | undefined {
	const piece = content.slice(p.start, p.end);
	const around = enclosingForbidden(out.text, out.at);
	if (around === undefined) return undefined;
	const intoStore = scanStoreEntries(out.text).some(
		(e) => e.start === around.start,
	);
	return place(
		out.text,
		p.closer && !intoStore ? around.end : around.start,
		piece,
		p,
		out.at,
	);
}

// `text` with `piece` put back at `at`. A closer ends its passage there,
// before any whitespace; a marker goes where a new one asked for at `from`
// goes now (just before what it was in, or after the properties).
function place(
	text: string,
	at: number,
	piece: string,
	p: Piece,
	from: number,
): string | undefined {
	if (p.closer) {
		let c = at;
		while (c > 0 && /\s/.test(text.charAt(c - 1))) c -= 1;
		return text.slice(0, c) + piece + text.slice(c);
	}
	const plan = planSafeMarkerInsert(text, from, piece.includes('\n'));
	if (plan === undefined) return undefined;
	return (
		text.slice(0, plan.at) +
		layoutMarker(plan, piece, ' ') +
		text.slice(plan.at)
	);
}

// A piece written into a store entry of a note kept in end-of-file storage,
// after the store was rewritten. The old composer rewrote it straight after
// inserting the marker (and so does every later write to such a note). The
// rewrite read the entry as ending at the piece's `-->`, could not decode it,
// and moved it, piece and all, to the end of the note, leaving the rest of the
// entry behind as text where the store had been: its JSON, then a stray `-->`.
//
// The two halves are joined again and the piece goes just before the store,
// where a new one there would go. The left-behind half is found by decoding,
// not guessed: it has no `<` or `>` (the store escapes both), it follows the
// blank line the store region opens with, and joined to the moved half it
// decodes to an entry the note does not already hold.
function rejoinStore(content: string): string | undefined {
	const decoded = new Set(parseStore(content).map((e) => e.comment.id));
	const all = pieces(content);
	for (const b of scanStoreEntries(content)) {
		if (decodeStoreEntry(b.json) !== undefined) continue;
		const p = all.find((x) => x.end === b.end && x.start > b.start);
		if (p === undefined) continue;
		const head = content.slice(b.start, p.start);
		if (!/^<!--\s*annoteca:store\b/.test(head)) continue;
		const piece = content.slice(p.start, p.end);
		// The left-behind half runs to the end of the entry's own `-->`, or
		// what is left of it when the piece went into the `-->` itself.
		for (
			let g = content.indexOf('>');
			g !== -1 && g < b.start;
			g = content.indexOf('>', g + 1)
		) {
			const t = g + 1;
			const angle = Math.max(
				content.lastIndexOf('<', g - 1),
				content.lastIndexOf('>', g - 1),
			);
			for (let s = angle + 1; s < t; s++) {
				if (
					s !== 0 &&
					s !== angle + 1 &&
					content.slice(s - 2, s) !== '\n\n'
				)
					continue;
				const restored = rejoined(head, content.slice(s, t), piece, p);
				if (restored === undefined) continue;
				const whole = /^<!--\s*annoteca:store\b([\s\S]*?)-->$/.exec(
					restored,
				);
				const entry =
					whole?.[1] === undefined
						? undefined
						: decodeStoreEntry(whole[1]);
				if (entry === undefined || decoded.has(entry.id)) continue;
				const rest =
					content.slice(0, b.start) + restored + content.slice(b.end);
				const prose = rest.slice(0, s) + rest.slice(t);
				return place(prose, s, piece, p, s);
			}
		}
	}
	return undefined;
}

// The entry as it was before `piece` went in between `head` and `tail`. The
// old composer laid the piece out with spacing (a space after it on a
// selection, a line break and indent after a bullet-like line, a space before
// it when appended to the line above), and inside a JSON string that spacing
// became text, so the cut that exactly undoes the insert is taken, as in
// withouts. Undefined when no cut gives a store entry.
function rejoined(
	head: string,
	tail: string,
	piece: string,
	p: Piece,
): string | undefined {
	const befores = head.endsWith(' ') ? [0, 1] : [0];
	const lead = /^(?: |\n[ \t]*)/.exec(tail)?.[0].length ?? 0;
	const afters = lead > 0 ? [0, lead] : [0];
	const fits: { text: string; cut: number; exact: boolean }[] = [];
	for (const b of befores)
		for (const a of afters) {
			const text = head.slice(0, head.length - b) + tail.slice(a);
			if (!/^<!--\s*annoteca:store\b[\s\S]*-->$/.test(text)) continue;
			// The entry stands on its own lines, so the planner sees all the
			// context it reads from the entry alone.
			const note = `\n\n${text}`;
			const at = 2 + head.length - b;
			const laid = head.slice(head.length - b) + piece + tail.slice(0, a);
			const next = note.indexOf('\n', at);
			const exact = (next === -1 ? [at] : [at, next + 1]).some((c) => {
				const plan = planMarkerInsert(note, c, piece.includes('\n'));
				return (
					plan.at === at &&
					layoutMarker(plan, piece, p.inline) === laid
				);
			});
			fits.push({ text, cut: a + b, exact });
		}
	fits.sort((x, y) => Number(y.exact) - Number(x.exact) || y.cut - x.cut);
	const exact = fits.find((f) => f.exact);
	return (exact ?? fits.find((f) => f.cut === 0))?.text;
}

// One lift that helps, or undefined when none does.
function liftOne(content: string): string | undefined {
	const before = damage(content);
	if (before === 0) return undefined;
	const had = ids(content);
	const keeps = (next: string | undefined): next is string => {
		if (next === undefined || damage(next) >= before) return false;
		const kept = ids(next);
		return [...had].every((id) => kept.has(id));
	};
	for (const p of suspects(content)) {
		if (!nested(content, p)) continue;
		for (const out of withouts(content, p)) {
			const next = lift(content, p, out);
			if (keeps(next)) return next;
		}
	}
	const rejoined = rejoinStore(content);
	return keeps(rejoined) ? rejoined : undefined;
}

// Lift every piece that was written inside another one. `converted` is how
// many moved. Bounded: each lift lowers the damage count, so the loop ends
// on its own well before the guard.
export function repairNestedMarkers(content: string): ImportResult {
	let updated = content;
	let moved = 0;
	for (let step = 0; step < 256; step++) {
		const next = liftOne(updated);
		if (next === undefined) break;
		updated = next;
		moved += 1;
	}
	return { updated, converted: moved };
}
