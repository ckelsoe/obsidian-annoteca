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

import { countWhile } from './span-index';
import { detectRangeIssues } from './diagnostics';
import { isLeanMarker } from './document';
import { enclosingForbidden } from './forbidden';
import type { ImportResult } from './imports';
import {
	layoutMarker,
	markerRemovalSpan,
	safeLineStarts,
	planMarkerInsert,
	planSafeMarkerInsert,
} from './marker-placement';
import { findMalformedMarkers, parseAll, scanClosers } from './parser';
import { frontmatterEnd } from './range-placement';
import {
	jsonBetweenTokens,
	jsonComplete,
	jsonFeed,
	jsonFork,
	jsonStart,
} from './json-scan';
import {
	decodeStoreEntry,
	encodeStoreEntry,
	parseStore,
	scanStoreEntries,
	type StoredComment,
} from './store';

// Store entries by id, from the whole note, for a stretch of it repaired on
// its own: a lean marker's date lives in its entry at the end of the note.
type Stored = ReadonlyMap<string, StoredComment>;

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
function pieces(content: string, known?: Stored): Piece[] {
	const markers = parseAll(content);
	// This text's own entries first, then the whole note's, looked up rather
	// than copied: a stretch repaired on its own must not copy the note's
	// whole store each time.
	const own = new Map(
		parseStore(content).map((e) => [e.comment.id, e.comment]),
	);
	const stored = {
		get: (id: string): StoredComment | undefined =>
			own.get(id) ?? known?.get(id),
	};
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

// How damaged a note reads, counted note-wide in one pass each: stray and
// merged openers, store entries that no longer decode, and range closers
// that lost their pair. Pieces sitting inside something are asked about one
// at a time (nested), since each question costs a parse of the note.
function damage(content: string): number {
	const malformed = findMalformedMarkers(content).filter(
		(f) => f.kind !== 'malformed',
	).length;
	const store = scanStoreEntries(content).filter(
		(e) => decodeStoreEntry(e.json) === undefined,
	).length;
	const ranges = detectRangeIssues(content, '').length;
	return malformed + store + ranges;
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
function suspects(content: string, known?: Stored): Piece[] {
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
		const lo = countWhile(xs.length, (mid) => (xs[mid] ?? 0) < x);
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
		// At most three dashes before it on its line: looked at no further
		// back than that, rather than searching a long line for its start.
		let lineStart = p.start;
		while (lineStart > 0 && content.charAt(lineStart - 1) !== '\n') {
			if (p.start - lineStart >= 3) return false;
			lineStart -= 1;
		}
		const lead = content.slice(lineStart, p.start);
		const lineEnd = content.indexOf('\n', p.end);
		const rest = content.slice(p.end, lineEnd === -1 ? undefined : lineEnd);
		return (
			/^-{0,3}$/.test(lead) &&
			/^ ?-{0,3}[ \t]*$/.test(rest) &&
			lead.length + rest.trim().length === 3
		);
	};
	return pieces(content, known).filter(
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
): Placed | undefined {
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
): Placed | undefined {
	if (p.closer) {
		let c = at;
		while (c > 0 && /\s/.test(text.charAt(c - 1))) c -= 1;
		return {
			text: text.slice(0, c) + piece + text.slice(c),
			start: c,
			insertAt: c,
			inserted: piece,
		};
	}
	const plan = planSafeMarkerInsert(text, from, piece.includes('\n'));
	if (plan === undefined) return undefined;
	const inserted = layoutMarker(plan, piece, ' ');
	return {
		text: text.slice(0, plan.at) + inserted + text.slice(plan.at),
		start: plan.at + plan.before.length,
		insertAt: plan.at,
		inserted,
	};
}

// A note after a lift, where the lifted piece now starts in it, and what
// was inserted where (in the note with the piece taken out).
interface Placed {
	text: string;
	start: number;
	insertAt: number;
	inserted: string;
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
// decodes to an entry the note does not already hold. Each such join is
// offered in turn, and the caller keeps the first that checks out.
function* rejoinStore(
	content: string,
	marked: boolean,
	canonical: boolean,
	known?: Stored,
): Generator<{ placed: Placed[]; piece: Piece }> {
	const decoded = new Set(parseStore(content).map((e) => e.comment.id));
	// The ids of lean markers still waiting for their entry. A head cut
	// inside its id can take another entry's tail, cut inside that one's id,
	// and decode as an id the note never had. Only a lean marker with no
	// entry vouches for an id: a full comment that happens to carry the
	// made-up id needs no entry, and must not pull the join its way.
	const waiting = new Set<string>();
	for (const c of parseAll(content))
		if (c.id !== undefined && !decoded.has(c.id) && isLeanMarker(c))
			waiting.add(c.id);
	// Every closer in the note, wherever it sits now, by id: a broken entry
	// can often be finished by more than one left-behind half, and only the
	// one that gives a range comment its range, and no other comment one,
	// is its own.
	const closerIds = new Set<string>();
	for (const k of scanClosers(content, [])) closerIds.add(k.id);
	// By end, so each broken entry looks up its piece instead of searching
	// them all.
	const pieceByEnd = new Map<number, Piece>();
	for (const x of pieces(content, known))
		if (!pieceByEnd.has(x.end)) pieceByEnd.set(x.end, x);
	for (const b of scanStoreEntries(content)) {
		if (decodeStoreEntry(b.json) !== undefined) continue;
		const found = pieceByEnd.get(b.end);
		const p =
			found !== undefined && found.start > b.start ? found : undefined;
		if (p === undefined) continue;
		const head = content.slice(b.start, p.start);
		const opener = /^<!--\s*annoteca:store\b/.exec(head);
		if (opener === null) continue;
		// The entry's JSON up to the piece, scanned once. Each place the other
		// half might start is first asked whether the text from there can
		// finish that JSON, which prose fails within a few characters; only a
		// candidate that can is built and decoded. Building and decoding every
		// one was quadratic in a gap full of blank lines.
		const headJson = jsonStart();
		const scannable = jsonFeed(
			headJson,
			head,
			opener[0].length,
			head.length,
		);
		const between = scannable && jsonBetweenTokens(headJson);
		const failedAt = new Set<number>();
		let runEnd = -1;
		const canFinish = (s: number, t: number): boolean => {
			if (!scannable || t - s < 3) return true;
			if (content.slice(t - 3, t) !== '-->') return false;
			// The separator rejoined may cut: one space, or a line break and
			// the indent after it.
			let lead = 0;
			if (content.charAt(s) === ' ') lead = 1;
			else if (content.charAt(s) === '\n') {
				lead = 1;
				while (
					content.charAt(s + lead) === ' ' ||
					content.charAt(s + lead) === '\t'
				)
					lead += 1;
			}
			return [0, lead].some((cut) => {
				const st = jsonFork(headJson);
				return (
					jsonFeed(st, content, s + cut, t - 3) && jsonComplete(st)
				);
			});
		};
		const piece = content.slice(p.start, p.end);
		// The left-behind half runs to the end of the entry's own `-->`, or
		// what is left of it when the piece went into the `-->` itself.
		// One pass, carrying the last `<` or `>` seen, rather than searching
		// back for it from every `>`: a note of quotes has many `>` and few
		// `<`, which made the search quadratic.
		let angle = -1;
		for (let g = 0; g < b.start; g++) {
			const ch = content.charAt(g);
			if (ch !== '>') {
				if (ch === '<') angle = g;
				continue;
			}
			const t = g + 1;
			const from = angle;
			angle = g;
			// Where the left-behind half can start: just after the last `<`
			// or `>`, the start of the note, or just after a blank line.
			for (let s = from + 1; s < t; s++) {
				if (
					s !== 0 &&
					s !== from + 1 &&
					content.slice(s - 2, s) !== '\n\n'
				)
					continue;
				// Between JSON tokens, starts that differ only in leading JSON
				// whitespace (space, tab, CR, LF; not every Unicode space) give
				// the same entry, so one that failed rules out
				// the rest of its whitespace run: trying each was quadratic in
				// a long run of blank lines.
				let firstText = s;
				if (between) {
					if (s < runEnd) firstText = runEnd;
					else {
						runEnd = s;
						while (
							runEnd < t &&
							' \t\r\n'.includes(content.charAt(runEnd))
						)
							runEnd += 1;
						firstText = runEnd;
					}
					if (s !== firstText && failedAt.has(firstText)) continue;
				}
				const fail = (): void => {
					if (between && s !== firstText) failedAt.add(firstText);
				};
				if (!canFinish(s, t)) {
					fail();
					continue;
				}
				const restored = rejoined(head, content.slice(s, t), piece, p);
				if (restored === undefined) {
					fail();
					continue;
				}
				const whole = /^<!--\s*annoteca:store\b([\s\S]*?)-->$/.exec(
					restored,
				);
				const entry =
					whole?.[1] === undefined
						? undefined
						: decodeStoreEntry(whole[1]);
				if (entry === undefined || decoded.has(entry.id)) {
					fail();
					continue;
				}
				if ((entry.range === 'closed') !== closerIds.has(entry.id))
					continue;
				if (waiting.has(entry.id) !== marked) continue;
				// Joins that give back exactly what the store writes come first:
				// JSON takes a repeated key, so a half can finish another
				// entry's head and still decode. A hand-edited entry is never
				// canonical and is tried after them.
				if ((encodeStoreEntry(entry) === restored) !== canonical)
					continue;
				const rest =
					content.slice(0, b.start) + restored + content.slice(b.end);
				const prose = rest.slice(0, s) + rest.slice(t);
				// A closer ends its passage before the closers already there,
				// or after them: whichever keeps the ranges nested is for
				// helpsIn to find. Two closers split into entries one rewrite
				// after another both end where the store began.
				const spots = [s];
				if (p.closer) {
					const run = /\s*<!--\s*\/annoteca\s+[a-z0-9]{1,32}\s*-->/y;
					let c = s;
					while (c > 0 && /\s/.test(prose.charAt(c - 1))) c -= 1;
					let end = c;
					run.lastIndex = c;
					while (run.exec(prose) !== null) end = run.lastIndex;
					if (end > c) spots.push(end);
				}
				const placed: Placed[] = [];
				for (const at of spots) {
					const one = place(prose, at, piece, p, at);
					if (one !== undefined) placed.push(one);
				}
				yield { placed, piece: p };
			}
		}
	}
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

// One lift that helps, or undefined when none does. A lift helps when the
// piece it moved no longer sits inside anything, no note-wide damage count
// went up, and no comment was lost. Moving a piece out cannot put another one
// inside something: it goes where nothing is, and the host it leaves is only
// made whole. So the note is strictly less damaged, and only the moved piece
// needs asking about, not every piece again.
// Whether a lift in `content` helps: the moved piece no longer sits inside
// anything, no note-wide damage count went up, and no comment was lost.
function helpsIn(
	content: string,
): (p: Piece, placed: Placed | undefined) => placed is Placed {
	const before = damage(content);
	const had = ids(content);
	const entries = scanStoreEntries(content).length;
	return (p: Piece, placed: Placed | undefined): placed is Placed => {
		if (placed === undefined || damage(placed.text) > before) return false;
		// Taking a piece out of a broken store entry whose `-->` it was read
		// as ending at can run that entry on into the next one. The two then
		// count as one broken entry instead of two, which reads as less
		// damage while both are still lost.
		if (scanStoreEntries(placed.text).length < entries) return false;
		const moved = {
			...p,
			start: placed.start,
			end: placed.start + p.end - p.start,
		};
		if (nested(placed.text, moved)) return false;
		const kept = ids(placed.text);
		return [...had].every((id) => kept.has(id));
	};
}

// Whether taking `p` out runs the store entry its `-->` ends on into the next
// entry, or to no `-->` at all: then the entry count drops, and helpsIn turns
// the lift down whatever it is. Asked first because it is cheap, and each lift
// it saves reads the whole note: with many broken entries, trying and
// rejecting one per entry at every step was cubic.
function runsOnInStore(
	content: string,
	p: Piece,
	storeStartByEnd: ReadonlyMap<number, number>,
): boolean {
	const start = storeStartByEnd.get(p.end);
	if (start === undefined || start >= p.start) return false;
	// A piece written into the entry's own `-->` gives it back when it goes,
	// and a cut that takes a character next to the piece can too: none of
	// that is ruled out here, and helpsIn decides.
	const edges =
		content.slice(Math.max(0, p.start - 3), p.start) +
		content.slice(p.end, p.end + 3);
	if (/[->]/.test(edges)) return false;
	const next = content.indexOf('-->', p.end);
	if (next === -1) return true;
	return /<!--\s*annoteca:store\b/.test(content.slice(p.end, next));
}

function liftOne(
	content: string,
	known?: Stored,
	rejoins = true,
): string | undefined {
	const before = damage(content);
	const helps = helpsIn(content);
	const storeStartByEnd = new Map(
		scanStoreEntries(content).map((e) => [e.end, e.start]),
	);
	for (const p of suspects(content, known)) {
		if (runsOnInStore(content, p, storeStartByEnd)) continue;
		if (!nested(content, p)) continue;
		for (const out of withouts(content, p)) {
			const placed = lift(content, p, out);
			if (helps(p, placed)) return placed.text;
		}
	}
	if (!rejoins) return undefined;
	// A rejoin has to mend the store entry it rebuilt, too.
	// Every way to rejoin that decodes, in order: with several entries split,
	// the first JSON that fits can be another entry's other half, which the
	// checks turn down.
	// A join that gives a lean marker its missing entry comes before one that
	// does not, which is kept for an entry whose marker was deleted.
	for (const marked of [true, false])
		for (const canonical of [true, false])
			for (const rejoined of rejoinStore(
				content,
				marked,
				canonical,
				known,
			))
				for (const placed of rejoined.placed)
					if (
						damage(placed.text) < before &&
						helps(rejoined.piece, placed)
					)
						return placed.text;
	return undefined;
}

// Whether the repair would do anything: one step of it, for the damage
// notice, which only asks yes or no on the note being opened or saved.
export function hasRepairableNesting(content: string): boolean {
	return liftOne(content) !== undefined;
}

// How many comments and range ends sit where the repair would look for
// them, counted in one pass without repairing. Exact for the damage that is
// slow to repair, many comments written into one stretch of a note; a chain
// of comments written into each other counts as its first only, and that
// repairs quickly. Used to warn before a repair that may take seconds, so it
// is not shown as a number.
export function damagedPieceCount(content: string): number {
	return suspects(content).length;
}

// Past this many, a repair can take a second or more rather than a moment:
// 160 took up to 2 s in the slowest shapes measured.
export const SLOW_REPAIR_PIECES = 100;

// Lift every piece that was written inside another one. `converted` is how
// many moved.
//
// Each piece is repaired within a stretch of the note around it: from a line
// start before the comment it went into, to a line start after the `-->` that
// now ends that comment, both outside every HTML comment and the properties,
// so the stretch read alone parses as the whole note does there. Stretches
// that overlap are joined. Repairing the whole note per piece made a note
// with many of them quadratic. What a stretch cannot settle alone (a store entry
// split across the note, broken properties) is left to a pass over the whole
// note afterwards, which then finds little or nothing to do. A stretch never
// rejoins a store entry, even when it holds both halves: the halves it can see
// need not be each other's, and with other entries split outside it, joining
// two that fit paired them wrongly and left the rest unreadable.
export function repairNestedMarkers(content: string): ImportResult {
	const known: Stored = new Map(
		parseStore(content).map((e) => [e.comment.id, e.comment]),
	);
	const lineStarts = [0];
	for (let i = 0; i < content.length; i++)
		if (content.charAt(i) === '\n') lineStarts.push(i + 1);
	const safe = safeLineStarts(content, lineStarts);
	const spans: { lo: number; hi: number }[] = [];
	const lineStartOf = (pos: number): number =>
		pos <= 0 ? 0 : content.lastIndexOf('\n', pos - 1) + 1;
	// How far a stretch holding `p` must reach: on to the `-->` that ends the
	// comment it went into, and past the line after its own last line, since
	// whether a lift takes the line break after it depends on that line.
	const reach = (p: Piece): number => {
		const closes = content.indexOf('-->', p.end);
		const eol = content.indexOf('\n', p.end);
		const nextEol = eol === -1 ? -1 : content.indexOf('\n', eol + 1);
		const after = nextEol === -1 ? content.length : nextEol + 1;
		return safe.atOrAfter(
			Math.max(closes === -1 ? content.length : closes + 3, after),
		);
	};
	for (const p of suspects(content, known)) {
		// Back to the comment it went into, past the whitespace before that
		// (a closer lifted out of a store entry goes back over it to the end
		// of its passage), and one line further (a marker's placement reads
		// the line above).
		const host = content.lastIndexOf('<!--', p.start - 1);
		let back = host === -1 ? p.start : host;
		while (back > 0 && /\s/.test(content.charAt(back - 1))) back -= 1;
		const lo = safe.atOrBefore(lineStartOf(lineStartOf(back) - 1));
		spans.push({ lo, hi: reach(p) });
	}
	spans.sort((a, b) => a.lo - b.lo);
	// A stretch lifts every comment in it, not only the one it was opened
	// for, so it reaches as far as each of them needs: all the comments are
	// walked once, in order, alongside the stretches. Stretches that then
	// only touch are independent: each writes and reads within itself.
	const all = pieces(content, known).sort((a, b) => a.start - b.start);
	let next = 0;
	const merged: { lo: number; hi: number }[] = [];
	for (const sp of spans) {
		const last = merged[merged.length - 1];
		let current: { lo: number; hi: number };
		if (last !== undefined && sp.lo < last.hi) {
			last.hi = Math.max(last.hi, sp.hi);
			current = last;
		} else {
			current = { ...sp };
			merged.push(current);
		}
		while (next < all.length && (all[next]?.start ?? Infinity) < current.lo)
			next += 1;
		for (; next < all.length; next++) {
			const q = all[next];
			if (q === undefined || q.start >= current.hi) break;
			current.hi = Math.max(current.hi, reach(q));
		}
	}
	let updated = '';
	let at = 0;
	let moved = 0;
	for (const sp of merged) {
		const local = repairWhole(
			content.slice(sp.lo, sp.hi),
			known,
			true,
			false,
		);
		updated += content.slice(at, sp.lo) + local.updated;
		at = sp.hi;
		moved += local.converted;
	}
	updated += content.slice(at);
	const rest = repairWhole(updated);
	return { updated: rest.updated, converted: moved + rest.converted };
}

// The repair over one string, a lift at a time (after lifting any chain in one
// pass, unless `chains` is off; rejoining split store entries unless
// `rejoins` is off). Exported for the tests that hold the
// stretch-by-stretch repair and the chain pass to the plain walk.
export function repairWhole(
	content: string,
	known?: Stored,
	chains = true,
	rejoins = true,
): ImportResult {
	let updated = content;
	let moved = 0;
	// Each lift takes one piece out of what it was in for good, and a lift can
	// make a broken host readable, a piece of its own, so there are never more
	// lifts than `<!--` in the note. The bound only guards against a loop.
	let bound = 1;
	for (
		let at = content.indexOf('<!--');
		at !== -1;
		at = content.indexOf('<!--', at + 1)
	)
		bound += 1;
	for (let step = 0; step < bound; step++) {
		const chained = chains ? chainRepair(updated, known) : undefined;
		if (chained !== undefined) {
			updated = chained.updated;
			moved += chained.converted;
			continue;
		}
		const next = liftOne(updated, known, rejoins);
		if (next === undefined) break;
		updated = next;
		moved += 1;
	}
	return { updated, converted: moved };
}

// Many comments written into one comment. The one-at-a-time repair lifts
// them in order, each lift revealing the next, and each re-reads the whole
// comment, which still holds all the rest: quadratic in their number. Here
// each lift is planned on a small stretch that reads as the note does where
// that lift looks: the lines before the outer comment (as earlier lifts left
// them), the outer comment's opener and the last lines of its text so far,
// the comment being lifted, the text after it, and the outer comment's own
// end. The stretches' results are stitched into the note, which is checked
// once at the end. Undefined (and the caller repairs one at a time) when the
// note is not that shape, a step finds no lift that helps, or the result
// does not check out. Held to the one-at-a-time repair by a test.
function chainRepair(
	content: string,
	known?: Stored,
): ImportResult | undefined {
	if (frontmatterEnd(content) > 0) return undefined;
	const findings = findMalformedMarkers(content);
	// The first damaged comment in the note, which the plain walk reaches
	// first, and only when nothing before it needs lifting.
	const opener = findings.find((f) => f.kind === 'unclosed-opener');
	if (opener === undefined) return undefined;
	const h = opener.start;
	if (findings.some((f) => f.kind === 'possible-merge' && f.start < h))
		return undefined;
	if (
		scanStoreEntries(content).some(
			(e) => e.start < h && decodeStoreEntry(e.json) === undefined,
		)
	)
		return undefined;
	if (suspects(content, known).some((p) => p.start < h && nested(content, p)))
		return undefined;
	const stub = /<!--\s*annoteca\/[a-z0-9-]+\s*:/iy;
	stub.lastIndex = h;
	const token = stub.exec(content)?.[0];
	if (token === undefined) return undefined;
	// The comments in a row inside the outer one: nothing between them
	// closes it.
	const chain: Piece[] = [];
	let at = h;
	for (const p of pieces(content, known).sort((a, b) => a.start - b.start)) {
		if (p.start <= h || p.closer) continue;
		const closes = content.indexOf('-->', at);
		if (closes !== -1 && closes < p.start) break;
		chain.push(p);
		at = p.end;
	}
	const last = chain[chain.length - 1];
	if (chain.length < 2 || last === undefined) return undefined;
	const closes = content.indexOf('-->', last.end);
	if (closes === -1) return undefined;
	const tailEnd = closes + 3;
	const tail = content.slice(last.end, tailEnd);

	// The text before the outer comment, and the outer comment's text so far,
	// each kept as settled chunks and a small working end that holds every
	// line a lift reads.
	const keep = (text: string): number => {
		const lastNl = text.lastIndexOf('\n');
		if (lastNl === -1) return 0;
		// Not lastIndexOf from -1, which still looks at offset 0.
		const prevStart =
			lastNl === 0 ? 0 : text.lastIndexOf('\n', lastNl - 1) + 1;
		let end = lastNl;
		while (end > prevStart && /\s/.test(text.charAt(end - 1))) end -= 1;
		if (text.slice(end - 3, end) === '-->') {
			const o = text.lastIndexOf('<!--', end - 3);
			if (o !== -1 && o < prevStart)
				return text.lastIndexOf('\n', o - 1) + 1;
		}
		return prevStart;
	};
	const settledBefore: string[] = [];
	let before = content.slice(0, h);
	let beforeHead = '';
	const settledHost: string[] = [];
	let host = content.slice(h, chain[0]?.start ?? h);
	let hostHead = '';
	// The outer comment's first line as it stands once its text is trimmed:
	// later lifts only change text after it, and a lift reads it when it is
	// two lines up.
	let firstLine: string | undefined;
	// A long line with no break in reach keeps only its first characters, a
	// stand-in, and its end in the stretch: what a lift reads on it (the
	// block syntax it starts with, whether it holds text, the characters
	// next to the comment) is all there. Its middle is settled only when it
	// holds whole HTML comments or none, so the stretch parses as the note.
	const HEAD = 32;
	const TAIL = 128;
	const settleable = (mid: string): boolean => {
		const edge = '<!->';
		if (
			edge.includes(mid.charAt(0)) ||
			edge.includes(mid.charAt(mid.length - 1))
		)
			return false;
		let open = false;
		const COMMENT = /<!--|-->/g;
		let m: RegExpExecArray | null;
		while ((m = COMMENT.exec(mid)) !== null) {
			if (m[0] === '<!--') open = true;
			else if (open) open = false;
			else return false;
		}
		return !open;
	};
	const shorten = (
		live: string,
		head: string,
		settled: string[],
	): { live: string; head: string } => {
		if (live.length <= 4 * TAIL || live.includes('\n'))
			return { live, head };
		const from = head === '' ? HEAD : 0;
		const to = live.length - TAIL;
		// Only a line whose kept start already holds a character no list,
		// quote or indent is made of: then no lead on it is block syntax with
		// or without its middle, and the stand-in cannot change that.
		const start = head === '' ? live.slice(0, HEAD) : head;
		if (!/[^ \t>\-*+0-9.)]/.test(start)) return { live, head };
		if (!settleable(live.slice(from, to))) return { live, head };
		settled.push(live.slice(0, to));
		return {
			live: live.slice(to),
			head: head === '' ? live.slice(0, HEAD) : head,
		};
	};
	const view = (live: string, head: string): string =>
		head === '' ? live : `${head}x${live}`;
	const trim = (): void => {
		const b = keep(before);
		if (b > 0) {
			settledBefore.push(before.slice(0, b));
			before = before.slice(b);
			beforeHead = '';
		}
		({ live: before, head: beforeHead } = shorten(
			before,
			beforeHead,
			settledBefore,
		));
		const k = keep(host);
		if (k > 0) {
			if (firstLine === undefined) {
				const nl = host.indexOf('\n');
				firstLine = view(
					host.slice(0, nl === -1 ? host.length : nl),
					hostHead,
				);
			}
			settledHost.push(host.slice(0, k));
			host = host.slice(k);
			hostHead = '';
		}
		({ live: host, head: hostHead } = shorten(host, hostHead, settledHost));
	};
	trim();
	for (let i = 0; i < chain.length; i++) {
		const p = chain[i];
		if (p === undefined) return undefined;
		const piece = content.slice(p.start, p.end);
		const next = chain[i + 1];
		const seg =
			next === undefined ? tail : content.slice(p.end, next.start);
		// What follows: the text up to the next comment, a `<` standing for
		// that comment's first character, then the outer comment's end.
		const follow = next === undefined ? seg : `${seg}<${tail}`;
		// Trimmed: the first line, then the lines a lift reads. Whatever lay
		// between them is two or more lines up from the comment being lifted.
		const hostView = view(host, hostHead);
		const hostText =
			firstLine === undefined ? hostView : `${firstLine}\n${hostView}`;
		// A leading line break so a stretch never opens like properties.
		const beforeView = view(before, beforeHead);
		const local = `\n${beforeView}${hostText}${piece}${follow}`;
		const hostAt = 1 + beforeView.length;
		const pAt = hostAt + hostText.length;
		const lp: Piece = { ...p, start: pAt, end: pAt + piece.length };
		const helps = helpsIn(local);
		let done = false;
		for (const out of withouts(local, lp)) {
			const placed = lift(local, lp, out);
			if (!helps(lp, placed)) continue;
			const cutTo = out.at + (local.length - out.text.length);
			const fromP = out.at - pAt;
			const toAfter = cutTo - (pAt + piece.length);
			// The insertion lands in the part of the text before the outer
			// comment that the stretch holds whole.
			const shown = beforeView.length - before.length;
			if (placed.insertAt < 1 + shown || placed.insertAt > hostAt)
				return undefined;
			if (
				fromP > 0 ||
				-fromP > host.length ||
				toAfter < 0 ||
				toAfter > seg.length
			)
				return undefined;
			const kept = host.slice(0, host.length + fromP);
			const rest = seg.slice(toAfter);
			// Taking the comment out must not close the outer one early: the
			// halves of a `-->` it was written into would meet again, and
			// what follows would no longer be inside.
			if (next !== undefined && (kept.slice(-2) + rest).includes('-->'))
				return undefined;
			const x = placed.insertAt - 1 - shown;
			before = before.slice(0, x) + placed.inserted + before.slice(x);
			host = kept + rest;
			done = true;
			break;
		}
		if (!done) return undefined;
		trim();
	}
	const updated =
		settledBefore.join('') +
		before +
		settledHost.join('') +
		host +
		content.slice(tailEnd);
	// Checked once: the outer comment is whole, nothing up to its end sits
	// inside anything, and every comment is still there. Damage further on
	// is the plain walk's, after this.
	if (damage(updated) >= damage(content)) return undefined;
	const end = updated.length - (content.length - tailEnd);
	if (
		suspects(updated, known).some(
			(p) => p.start < end && nested(updated, p),
		)
	)
		return undefined;
	const had = ids(content);
	const kept = ids(updated);
	if (![...had].every((id) => kept.has(id))) return undefined;
	return { updated, converted: chain.length };
}
