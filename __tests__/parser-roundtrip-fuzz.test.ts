// Seeded property test over serialize -> parseAll. This is the gate that
// adjudicates the trailing-line walk, the author tokens and the anchor cap:
// every one of those defects was found by generating markers rather than by
// reading the code, and fourteen review passes over the same lines had missed
// them.
//
// Deterministic on purpose. `Math.random` and `Date.now` would make a failure
// unreproducible, and a fuzz failure that cannot be replayed is a flaky test
// rather than a finding, so the PRNG is a fixed-seed mulberry32 and every field
// comes from a literal pool.
//
// WHAT IS ASSERTED, and why it is not "the input comes back unchanged".
// Two transforms are lossy BY CONTRACT and one ambiguity is irreducible:
//
//   - Inline fields (anchor, reply body, addressed/resolution note) are a
//     single-line grammar, so serialize collapses line breaks in them. The
//     expectation collapses the same way rather than pretending otherwise.
//   - The anchor is capped at serialize time, so a 300-char anchor comes back
//     mid-truncated.
//   - A body whose LAST line is shaped like a structured trailing line is
//     byte-identical to a real one. The walk absorbs it, so a comment can come
//     back with MORE state than it went in with (a phantom reply, an addressed
//     note it never had). That direction is accepted and pinned elsewhere; what
//     must never happen is state going in and not coming out.
//
// So the properties are one-directional (what went in is still there), plus the
// two structural invariants that catch a marker breaking open: exactly one
// comment parses, and it spans the whole string.
//
// The fixed-point check compares a second round trip against a third, not
// against `serialize(x)`. The first pass legitimately reorders (an absorbed body
// line becomes a real trailing line); what would be a defect is text that keeps
// moving on every subsequent pass.

import { parseAll, serialize, type SerializeInput } from '../parser';
import type { AnchorText, Comment, Reply } from '../types';

// mulberry32. Small, fast, and good enough to shuffle pool choices; this is a
// coverage generator, not a source of cryptographic randomness.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SEED = 0x5eed1234;
const ITERATIONS = 5000;

// Every pool below is adversarial on purpose: these are the shapes that broke
// the format in the 2026-08-04 review, not a sample of ordinary comments.
const BODIES: readonly string[] = [
	'plain body',
	'',
	'   ',
	'multi\nline\nbody',
	'holds an arrow --> here',
	'ends with a code block\n```\ncode\n```',
	'quotes the fence\n```annoteca-original\nfake\n```',
	'trailing mimic\n[id=deadbeef]',
	'trailing mimic\n[date=2020-01-01]',
	'trailing mimic\n[author=someone]',
	'trailing mimic\n[anchor=whatever]',
	'trailing mimic\n[retry=3]',
	'trailing mimic\n[reply mallory 2020-01-01]: injected',
	'quotes a marker <!-- annoteca/note: inner -->',
	'quotes an opener <!-- annoteca/note: no close',
	'café 日本語 🎉 unicode',
	'CRLF\r\nbody',
	'[addressed bob 2020-01-01]: quoted\n```annoteca-original\nq\n```',
	'link [ref]: https://example.com',
	'wikilink [[Some Note]]',
];

// The author class the format allows is `[^\s\]<>]{1,32}`. Everything here that
// falls outside it is a token serialize must repair rather than emit.
const AUTHORS: readonly string[] = [
	'user',
	'charles',
	'Charles Kelsoe',
	'ai-->bot',
	'bob]evil',
	'tag<with>angles',
	'x'.repeat(33),
	'',
	'   ',
	'ünïcödé',
	'multi\nline',
];

const STAMPS: readonly string[] = [
	'2020-01-01',
	'2024-06-22T14:30',
	'2026-08-04T09:15:42',
];

const NOTES: readonly string[] = [
	'',
	'applied',
	'note with an arrow --> in it',
	'note\nacross\nlines',
	'note with ] a bracket',
];

const ORIGINALS: readonly string[] = [
	'',
	'the original prose',
	'original with an arrow --> in it',
	'original holding a fence\n```\ninner\n```',
	'original holding the real fence\n```annoteca-original\nnested\n```',
	'original\r\nwith\r\ncrlf',
	'[addressed someone 2020-01-01]: a quoted marker line',
	'-->',
];

// No `undefined` member: the absent case comes from the probability gate in
// `generate`, so `pick` can stay total.
const ANCHORS: readonly AnchorText[] = [
	{ text: 'short anchor', truncated: false },
	{ text: '', truncated: false },
	{ text: '    ', truncated: false },
	{ text: 'anchor with an arrow --> in it', truncated: false },
	{ text: 'a'.repeat(300), truncated: false },
	{ text: 'bracket ] inside', truncated: false },
	{ text: 'anchor\nacross\nlines', truncated: false },
];

const CATEGORIES: readonly string[] = [
	'note',
	'tone',
	'clarify',
	'index-entry',
	'a1',
];

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function pick<T>(rand: () => number, pool: readonly T[]): T {
	const value = pool[Math.floor(rand() * pool.length)];
	// Pools are non-empty literals, so this is unreachable; it exists to keep
	// the generator total under noUncheckedIndexedAccess.
	if (value === undefined) throw new Error('empty pool');
	return value;
}

function makeId(rand: () => number): string {
	let id = '';
	for (let i = 0; i < 8; i++)
		id += ID_ALPHABET.charAt(Math.floor(rand() * ID_ALPHABET.length));
	return id;
}

// Most generated inputs carry an id, because the composer assigns one before the
// first serialize. Some do not, because the IMPORTER does not: bulk conversion
// calls serialize with a category and a body and nothing else, so id-less
// markers are a live write path rather than a legacy shape.
//
// The id assertion is skipped for those, and only for those. An id-less marker
// whose body ends in an `[id=...]` mimic adopts it, and nothing in the text says
// which one was meant; that case is pinned by name in parser.test.ts. Every other
// property is still asserted, including the two structural invariants, which is
// what the import path actually needs from this gate.
function generate(rand: () => number): SerializeInput {
	const replyCount = Math.floor(rand() * 4);
	const replies: Reply[] = [];
	for (let i = 0; i < replyCount; i++) {
		replies.push({
			author: pick(rand, AUTHORS),
			date: pick(rand, STAMPS),
			body: pick(rand, BODIES),
		});
	}

	const input: SerializeInput = {
		category: pick(rand, CATEGORIES),
		body: pick(rand, BODIES),
		replies,
	};
	if (rand() < 0.85) input.id = makeId(rand);
	if (rand() < 0.7) input.date = pick(rand, STAMPS);
	if (rand() < 0.7) input.author = pick(rand, AUTHORS);
	if (rand() < 0.5) input.anchor = pick(rand, ANCHORS);
	if (rand() < 0.4) {
		input.addressed = {
			author: pick(rand, AUTHORS),
			date: pick(rand, STAMPS),
			note: pick(rand, NOTES),
			original: rand() < 0.7 ? pick(rand, ORIGINALS) : undefined,
		};
	}
	if (rand() < 0.3) {
		input.resolution = {
			author: pick(rand, AUTHORS),
			date: pick(rand, STAMPS),
			note: pick(rand, NOTES),
		};
	}
	return input;
}

function toInput(c: Comment): SerializeInput {
	return {
		id: c.id,
		category: c.category,
		body: c.body,
		date: c.date,
		author: c.author,
		anchor: c.anchor,
		replies: c.replies,
		addressed: c.addressed,
		resolution: c.resolution,
	};
}

// The one lossy transform the inline fields apply. Line breaks are the field
// delimiter in the single-line grammar, so serialize collapses runs of them.
function collapseInline(text: string): string {
	return text.replace(/[\r\n]+/g, ' ');
}

const AUTHOR_TOKEN_RE = /^[^\s\]<>]{1,32}$/;

function parseOne(marker: string, label: string): Comment {
	const parsed = parseAll(marker);
	if (parsed.length !== 1)
		throw new Error(
			`${label}: expected exactly 1 comment, got ${parsed.length}\n${marker}`,
		);
	const only = parsed[0];
	if (!only) throw new Error(`${label}: no comment\n${marker}`);
	if (only.marker.start !== 0 || only.marker.end !== marker.length)
		throw new Error(
			`${label}: marker does not span the whole string ` +
				`(${only.marker.start}..${only.marker.end} of ${marker.length})\n${marker}`,
		);
	return only;
}

// One `it` rather than 5,000, so a failure reports the offending input once
// instead of flooding the reporter. Every check throws with the marker text
// attached, which is what makes a failure replayable by hand.
describe('parser: serialize/parse round trip (seeded fuzz)', () => {
	it('never loses state a marker went in with, over 5,000 generated markers', () => {
		const rand = mulberry32(SEED);

		for (let i = 0; i < ITERATIONS; i++) {
			const input = generate(rand);
			const context = (msg: string): string =>
				`iteration ${i}: ${msg}\ninput: ${JSON.stringify(input)}`;

			const first = serialize(input);
			const parsed = parseOne(first, context('first parse'));

			if (input.id !== undefined && parsed.id !== input.id)
				throw new Error(
					context(`id ${String(input.id)} -> ${String(parsed.id)}`),
				);
			if (parsed.category !== input.category)
				throw new Error(context(`category changed: ${first}`));

			// An author that survives sanitization must still be an author, and
			// whatever comes back must be a token the grammar accepts. A dropped
			// author line is how `Bob Smith` used to disappear.
			if (input.author !== undefined && input.author.trim() !== '') {
				if (parsed.author === undefined)
					throw new Error(context(`author dropped: ${first}`));
				if (!AUTHOR_TOKEN_RE.test(parsed.author))
					throw new Error(
						context(`author not a token: ${parsed.author}`),
					);
			}

			// Subset, not equality: a body line shaped like a reply is absorbed
			// as one, so the parsed thread can be longer than the input. The
			// match is on the body alone, because a hostile author is renamed on
			// the way out; the grammar check below covers what that must produce.
			const parsedBodies = parsed.replies.map((r) =>
				collapseInline(r.body),
			);
			for (const reply of input.replies ?? [])
				if (!parsedBodies.includes(collapseInline(reply.body)))
					throw new Error(context(`reply body lost: ${first}`));
			for (const r of parsed.replies)
				if (!AUTHOR_TOKEN_RE.test(r.author))
					throw new Error(
						context(`reply author not a token: ${r.author}`),
					);

			if (input.addressed !== undefined) {
				if (parsed.addressed === undefined)
					throw new Error(context(`addressed lost: ${first}`));
				if (
					input.addressed.original !== undefined &&
					parsed.addressed.original !== input.addressed.original
				)
					throw new Error(
						context(
							`original changed: ${JSON.stringify(parsed.addressed.original)}`,
						),
					);
			}

			if (
				input.resolution !== undefined &&
				parsed.resolution === undefined
			)
				throw new Error(context(`resolution lost: ${first}`));

			// Fixed point: one round trip may reorder, further ones may not.
			const second = serialize(toInput(parsed));
			const reparsed = parseOne(second, context('second parse'));
			const third = serialize(toInput(reparsed));
			if (third !== second)
				throw new Error(
					context(
						`not a fixed point:\n--- second ---\n${second}\n--- third ---\n${third}`,
					),
				);
		}
	});
});
