// The indexes that replaced per-item scans of a whole note: SpanIndex answers
// what a scan of every span answers (disjoint, touching, nested, overlapping,
// empty and note-long spans alike), and hasUniqueId what a count would.

import { SpanIndex, type Span } from '../span-index';
import type { Comment } from '../types';
import { hasUniqueId } from '../view-utils';
import {
	parseAll,
	serialize,
	serializeLeanMarker,
	unreadableOpeners,
} from '../parser';
import {
	blockPrefix,
	layoutMarker,
	markerBreaksReadingView,
	markerRemovalSpan,
	planMarkerInsert,
	repairMarkerPlacement,
} from '../marker-placement';
import { enclosingForbidden } from '../forbidden';
import type { ImportResult } from '../imports';
import { jsonComplete, jsonFeed, jsonFork, jsonStart } from '../json-scan';

// A small deterministic generator, so a failure reproduces.
function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2147483648;
		return s / 2147483648;
	};
}

function randomSpans(next: () => number, n: number, size: number): Span[] {
	const out: Span[] = [];
	for (let i = 0; i < n; i++) {
		const start = Math.floor(next() * size);
		const long = next() < 0.05;
		const len = long ? Math.floor(next() * size) : Math.floor(next() * 8);
		out.push({ start, end: start + len });
	}
	return out;
}

describe('SpanIndex', () => {
	it('matches a full scan for every query', () => {
		const next = rng(7);
		for (let round = 0; round < 200; round++) {
			const spans = randomSpans(next, Math.floor(next() * 40), 120);
			const index = new SpanIndex(spans, (s) => s);
			for (let q = 0; q < 40; q++) {
				const from = Math.floor(next() * 130) - 5;
				const to = from + Math.floor(next() * 12);
				const expected = spans
					.filter((s) => s.start < to && s.end > from)
					.sort((a, b) => a.start - b.start);
				const got = index.overlapping(from, to);
				expect(got.map((s) => [s.start, s.end])).toEqual(
					expected.map((s) => [s.start, s.end]),
				);
				expect(index.some(from, to)).toBe(expected.length > 0);
				expect(index.first(from, to)).toBe(expected[0]);
			}
		}
	});

	it('answers nothing for an empty set', () => {
		const index = new SpanIndex<Span>([], (s) => s);
		expect(index.overlapping(0, 10)).toEqual([]);
		expect(index.some(0, 10)).toBe(false);
	});
});

describe('hasUniqueId', () => {
	const c = (id: string | undefined): Comment => ({
		id,
		category: 'clarify',
		body: '',
		date: undefined,
		author: undefined,
		anchor: undefined,
		replies: [],
		addressed: undefined,
		resolution: undefined,
		unknownLines: [],
		marker: { start: 0, end: 1 },
		source: undefined,
	});

	it('is true only for an id no other comment in the note shares', () => {
		const note = [c('a'), c('b'), c('b'), c(undefined)];
		expect(hasUniqueId(note, { id: 'a' })).toBe(true);
		expect(hasUniqueId(note, { id: 'b' })).toBe(false);
		expect(hasUniqueId(note, { id: undefined })).toBe(false);
		expect(hasUniqueId(note, { id: 'z' })).toBe(false);
	});

	it('counts a re-read note afresh', () => {
		expect(hasUniqueId([c('a'), c('a')], { id: 'a' })).toBe(false);
		expect(hasUniqueId([c('a')], { id: 'a' })).toBe(true);
	});
});

describe('unreadableOpeners', () => {
	// The regex it replaced, kept here as the reference.
	const REFERENCE =
		/<!--\s*annoteca\/(?![a-z][a-z0-9-]*\s*:)[^>]{0,120}-->|<!--\s*annoteca\/[^a-z][^>]*-->/g;
	const reference = (content: string): number[] =>
		[...content.matchAll(REFERENCE)].map((m) => m.index);

	it('finds exactly what the regex found', () => {
		const pieces = [
			'<!-- annoteca/',
			'<!--annoteca/',
			'todo: ',
			'Todo',
			'1x',
			' ',
			'\n',
			'-->',
			'->',
			'>',
			'-',
			'x',
			'a'.repeat(60),
			':',
		];
		const next = rng(11);
		for (let round = 0; round < 3000; round++) {
			let s = '';
			const n = Math.floor(next() * 14);
			for (let i = 0; i < n; i++)
				s += pieces[Math.floor(next() * pieces.length)] ?? '';
			expect(unreadableOpeners(s)).toEqual(reference(s));
		}
	});
});

describe('repairMarkerPlacement in one pass', () => {
	// The walk it replaced: one marker at a time, latest first, each planned
	// against the note as the moves before it left it.
	function reference(content: string): ImportResult {
		const markers = parseAll(content)
			.map((c) => c.marker)
			.filter((m) => markerBreaksReadingView(content, m.start, m.end))
			.sort((a, b) => b.start - a.start);
		let updated = content;
		let moved = 0;
		for (const m of markers) {
			const marker = updated.slice(m.start, m.end);
			const cut = markerRemovalSpan(updated, m.start, m.end);
			const without = updated.slice(0, cut.from) + updated.slice(cut.to);
			const plan = planMarkerInsert(
				without,
				cut.from,
				marker.includes('\n'),
			);
			if (enclosingForbidden(without, plan.at) !== undefined) continue;
			updated =
				without.slice(0, plan.at) +
				layoutMarker(plan, marker, ' ') +
				without.slice(plan.at);
			moved += 1;
		}
		return { updated, converted: moved };
	}

	it('matches the one-at-a-time walk', () => {
		const next = rng(23);
		let id = 0;
		const marker = (): string => {
			id += 1;
			const tag = String(id).padStart(8, '0');
			return next() < 0.5
				? serialize({ id: tag, category: 'clarify', body: 'b' })
				: serializeLeanMarker('clarify', tag);
		};
		const lineKinds = [
			() => `${marker()} Para text.`,
			() => `Plain text ${marker()} inline.`,
			() => `- ${marker()} item`,
			() => `> ${marker()} quoted`,
			() => `# Head ${marker()}`,
			() => `## ${marker()} ${marker()} two on a heading`,
			() => `${marker()}${marker()} two at a start`,
			() => `${marker()}text right after`,
			() => `# H ${marker()}\n${marker()}text`,
			() => `## ${marker()} ${marker()}`,
			() => marker(),
			() => 'plain line',
			() => '',
			() => '1. numbered',
			() => '---',
		];
		for (let round = 0; round < 1500; round++) {
			const lines: string[] = [];
			const n = 1 + Math.floor(next() * 10);
			for (let i = 0; i < n; i++)
				lines.push(
					lineKinds[Math.floor(next() * lineKinds.length)]?.() ?? '',
				);
			const note = lines.join('\n');
			const got = repairMarkerPlacement(note);
			const want = reference(note);
			if (JSON.stringify(got) !== JSON.stringify(want))
				throw new Error(JSON.stringify({ note, got, want }));
		}
	});

	it('reads the line above trimmed, as the planner does', () => {
		const note =
			'<!-- annoteca/note: first\n[id=aaaaaaaa]\n-->  \n<!-- annoteca/note: second\n[id=bbbbbbbb]\n-->text';
		expect(repairMarkerPlacement(note)).toEqual(reference(note));
	});

	it('reads the line above back to its comment opener', () => {
		// Whether the line above ends a comment that opened its own block
		// depends on the line its `<!--` is on, two lines further up.
		const note =
			'<!-- annoteca/note: first\n[id=aaaaaaaa]\n-->\n<!-- annoteca/note: second\n[id=bbbbbbbb]\n-->text';
		expect(repairMarkerPlacement(note)).toEqual(reference(note));
	});
});

describe('blockPrefix by line shape', () => {
	// The function it replaced, which read each lead afresh.
	function reference(
		lead: string,
	): { quotes: boolean; bullet: boolean } | undefined {
		let i = 0;
		const spaces = (): void => {
			while (lead[i] === ' ' || lead[i] === '\t') i += 1;
		};
		spaces();
		let quotes = false;
		while (lead[i] === '>') {
			quotes = true;
			i += 1;
			spaces();
		}
		let bullet = false;
		const ch = lead[i];
		if (ch === '-' || ch === '*' || ch === '+') {
			bullet = true;
			i += 1;
		} else if (ch !== undefined && ch >= '0' && ch <= '9') {
			let j = i;
			const digit = (k: number): boolean =>
				lead.charAt(k) >= '0' &&
				lead.charAt(k) <= '9' &&
				k < lead.length;
			while (j - i < 9 && digit(j)) j += 1;
			if (lead[j] === '.' || lead[j] === ')') {
				bullet = true;
				i = j + 1;
			}
		}
		if (bullet) {
			if (lead[i] !== ' ' && lead[i] !== '\t') return undefined;
			spaces();
		}
		return i === lead.length ? { quotes, bullet } : undefined;
	}

	it('answers what reading each lead did, at every position of a line', () => {
		const chars = [
			' ',
			'\t',
			'>',
			'-',
			'*',
			'+',
			'1',
			'9',
			'0',
			'.',
			')',
			'a',
		];
		const next = rng(31);
		for (let round = 0; round < 4000; round++) {
			let line = '';
			const n = Math.floor(next() * 16);
			for (let i = 0; i < n; i++)
				line += chars[Math.floor(next() * chars.length)] ?? '';
			const note = `prev\n${line}\nafter`;
			for (let k = 0; k <= line.length; k++)
				expect(blockPrefix(note, 5, 5 + k)).toEqual(
					reference(line.slice(0, k)),
				);
		}
	});
});

describe('json-scan', () => {
	const accepts = (text: string): boolean => {
		const st = jsonStart();
		return jsonFeed(st, text, 0, text.length) && jsonComplete(st);
	};
	const parses = (text: string): boolean => {
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	};

	it('accepts exactly what JSON.parse accepts', () => {
		const pieces = [
			'{',
			'}',
			'[',
			']',
			'"',
			'\\',
			'u',
			'0',
			'a',
			'f',
			'1',
			'-',
			'.',
			'e',
			'+',
			':',
			',',
			' ',
			'\n',
			't',
			'r',
			'n',
			'l',
			's',
			'x',
			'"k"',
			'true',
			'null',
			'12',
			'\t',
		];
		const next = rng(41);
		for (let round = 0; round < 60000; round++) {
			let s = '';
			const n = Math.floor(next() * 10);
			for (let i = 0; i < n; i++)
				s += pieces[Math.floor(next() * pieces.length)] ?? '';
			if (accepts(s) !== parses(s))
				throw new Error(
					`${JSON.stringify(s)}: scan ${String(accepts(s))}`,
				);
		}
	});

	it('accepts real store entries, and resumes from a shared start', () => {
		const json = JSON.stringify(
			{
				v: 1,
				id: 'aaaaaaaa',
				body: 'line\nnext "q" \\ é',
				replies: [],
				n: -1.5e3,
			},
			null,
			2,
		);
		expect(accepts(json)).toBe(true);
		const head = jsonStart();
		expect(jsonFeed(head, json, 0, 20)).toBe(true);
		const ok = jsonFork(head);
		expect(jsonFeed(ok, json, 20, json.length) && jsonComplete(ok)).toBe(
			true,
		);
		const bad = jsonFork(head);
		expect(jsonFeed(bad, 'prose here', 0, 10) && jsonComplete(bad)).toBe(
			false,
		);
	});
});
