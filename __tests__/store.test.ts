import {
	decodeStoreEntry,
	encodeStoreEntry,
	parseStore,
	scanStoreEntries,
	STORE_SCHEMA_VERSION,
	type StoredComment,
} from '../store';
import type { AnchorText, Reply } from '../types';

// Pull the inner JSON back out of an encoded block, the way scanStoreEntries does,
// so a test can assert on the payload the wrapper carries.
function innerOf(block: string): string {
	const scanned = scanStoreEntries(block);
	expect(scanned).toHaveLength(1);
	const only = scanned[0];
	if (!only) throw new Error('no entry');
	return only.json;
}

function roundTrip(c: StoredComment): StoredComment | undefined {
	return decodeStoreEntry(innerOf(encodeStoreEntry(c)));
}

describe('store: encode/decode round trip', () => {
	it('round-trips a minimal comment (id + category + body only)', () => {
		const c: StoredComment = {
			id: 'a3b9c2x7',
			category: 'tone',
			body: 'soften this',
			replies: [],
		};
		expect(roundTrip(c)).toEqual(c);
	});

	it('round-trips a fully populated comment', () => {
		const c: StoredComment = {
			id: 'deadbeef',
			category: 'source-needed',
			body: 'multi\nline\nbody with a ] bracket',
			date: '2026-05-23T09:15:42',
			author: 'charles',
			anchor: { text: 'assumes a hiring freeze', truncated: false },
			replies: [
				{ author: 'ai', date: '2026-05-23', body: 'Consider this.' },
				{
					author: 'charles',
					date: '2026-05-24T10:00',
					body: 'multi\nline\nreply',
				},
			],
			addressed: {
				author: 'ai',
				date: '2026-05-23',
				note: 'applied',
				original: 'the verbatim pre-edit prose',
			},
			resolution: { author: 'charles', date: '2026-05-24', note: 'done' },
			unknownLines: ['[retry=3]', '[priority=high]'],
		};
		expect(roundTrip(c)).toEqual(c);
	});

	it('preserves multi-line reply bodies (lossless where the marker is not)', () => {
		const c: StoredComment = {
			id: 'a0000000',
			category: 'note',
			body: 'x',
			replies: [
				{
					author: 'ai',
					date: '2026-01-01',
					body: 'line one\nline two',
				},
			],
		};
		const out = roundTrip(c);
		expect(out?.replies[0]?.body).toBe('line one\nline two');
	});

	it('keeps an empty-string addressed original (distinct from absent)', () => {
		const c: StoredComment = {
			id: 'a0000001',
			category: 'note',
			body: 'x',
			replies: [],
			addressed: {
				author: 'ai',
				date: '2026-01-01',
				note: '',
				original: '',
			},
		};
		const out = roundTrip(c);
		expect(out?.addressed?.original).toBe('');
	});

	it('stamps the schema version into every entry', () => {
		const json = innerOf(
			encodeStoreEntry({
				id: 'a0000002',
				category: 'note',
				body: 'x',
				replies: [],
			}),
		);
		expect(JSON.parse(json).v).toBe(STORE_SCHEMA_VERSION);
	});

	it('omits absent fields rather than writing null', () => {
		const json = innerOf(
			encodeStoreEntry({
				id: 'a0000003',
				category: 'note',
				body: 'x',
				replies: [],
			}),
		);
		const obj = JSON.parse(json);
		expect('date' in obj).toBe(false);
		expect('author' in obj).toBe(false);
		expect('anchor' in obj).toBe(false);
		expect('addressed' in obj).toBe(false);
		expect('resolution' in obj).toBe(false);
		expect('replies' in obj).toBe(false); // empty array is omitted
	});
});

describe('store: HTML-comment delimiter hazards', () => {
	// Each of these would break the wrapper if written raw; all must survive and
	// leave the payload free of any `<` or `>`.
	const HAZARDS: readonly string[] = [
		'holds an arrow --> here',
		'opener <!-- annoteca/note: inner --> after',
		'triple dash ---> and back <---',
		'bare angles < and > and <> and ><',
		'nested <!--<!--<!-- openers',
		'terminator soup -->-->-->',
	];

	for (const hazard of HAZARDS) {
		it(`survives a body of ${JSON.stringify(hazard)}`, () => {
			const c: StoredComment = {
				id: 'a0000004',
				category: 'note',
				body: hazard,
				replies: [],
			};
			const block = encodeStoreEntry(c);
			const json = innerOf(block);
			// The invariant that makes lazy scanning correct: no angle brackets
			// remain in the payload, so it can hold neither `-->` nor `<!--`.
			expect(json.includes('<')).toBe(false);
			expect(json.includes('>')).toBe(false);
			// And it still decodes to exactly the original text.
			expect(decodeStoreEntry(json)?.body).toBe(hazard);
		});
	}

	it('a raw --> inside a value does not terminate the wrapper early', () => {
		const block = encodeStoreEntry({
			id: 'a0000005',
			category: 'note',
			body: 'before --> after',
			replies: [],
		});
		// Exactly one terminator: the real one. If the inner arrow had leaked, the
		// scanner would pair on it and report a shorter block.
		expect(scanStoreEntries(block)).toHaveLength(1);
		expect(scanStoreEntries(block)[0]?.end).toBe(block.length);
	});

	it('preserves a literal backslash-u sequence in the text unchanged', () => {
		// A body that literally contains the 6 characters > must not be
		// confused with the escape the encoder emits for a real `>`.
		const body = 'literal escape text \\u003e stays';
		const c: StoredComment = {
			id: 'a0000006',
			category: 'note',
			body,
			replies: [],
		};
		expect(roundTrip(c)?.body).toBe(body);
	});
});

describe('store: decode rejects malformed entries (failure isolation)', () => {
	it('returns undefined on invalid JSON', () => {
		expect(decodeStoreEntry('{ not valid json')).toBeUndefined();
		expect(decodeStoreEntry('')).toBeUndefined();
		expect(decodeStoreEntry('42')).toBeUndefined();
		expect(decodeStoreEntry('"a string"')).toBeUndefined();
	});

	it('rejects a missing or empty id', () => {
		expect(
			decodeStoreEntry(JSON.stringify({ category: 'note', body: 'x' })),
		).toBeUndefined();
		expect(
			decodeStoreEntry(
				JSON.stringify({ id: '', category: 'note', body: 'x' }),
			),
		).toBeUndefined();
	});

	it('rejects a missing or empty category', () => {
		expect(
			decodeStoreEntry(JSON.stringify({ id: 'a1', body: 'x' })),
		).toBeUndefined();
		expect(
			decodeStoreEntry(
				JSON.stringify({ id: 'a1', category: '', body: 'x' }),
			),
		).toBeUndefined();
	});

	it('rejects a wrong-typed field', () => {
		expect(
			decodeStoreEntry(
				JSON.stringify({ id: 5, category: 'note', body: 'x' }),
			),
		).toBeUndefined();
		expect(
			decodeStoreEntry(
				JSON.stringify({
					id: 'a1',
					category: 'note',
					body: 'x',
					replies: 'no',
				}),
			),
		).toBeUndefined();
		expect(
			decodeStoreEntry(
				JSON.stringify({
					id: 'a1',
					category: 'note',
					body: 'x',
					replies: [{ author: 'ai', date: '2026-01-01' }], // missing body
				}),
			),
		).toBeUndefined();
	});

	it('accepts a body of empty string', () => {
		const out = decodeStoreEntry(
			JSON.stringify({ id: 'a1', category: 'note', body: '' }),
		);
		expect(out?.body).toBe('');
	});

	it('decodes known fields from a future schema version', () => {
		const out = decodeStoreEntry(
			JSON.stringify({
				v: 999,
				id: 'a1',
				category: 'note',
				body: 'x',
				somethingNew: 'ignored',
			}),
		);
		expect(out?.body).toBe('x');
	});
});

describe('store: scan and parse a document region', () => {
	function block(c: StoredComment): string {
		return encodeStoreEntry(c);
	}

	it('finds every entry in file order', () => {
		const doc = [
			'# A note',
			'',
			'Some prose. <!-- annoteca/tone [id=a1] -->',
			'',
			block({ id: 'a1', category: 'tone', body: 'first', replies: [] }),
			block({ id: 'a2', category: 'note', body: 'second', replies: [] }),
		].join('\n');
		const parsed = parseStore(doc);
		expect(parsed.map((e) => e.comment.id)).toEqual(['a1', 'a2']);
	});

	it('quarantines one malformed entry and keeps the rest', () => {
		const good1 = block({
			id: 'a1',
			category: 'note',
			body: 'one',
			replies: [],
		});
		const bad = '<!-- annoteca:store\n{ this is not json }\n-->';
		const good2 = block({
			id: 'a2',
			category: 'note',
			body: 'two',
			replies: [],
		});
		const doc = [good1, bad, good2].join('\n\n');
		const parsed = parseStore(doc);
		// The bad block is scanned (it is a well-formed HTML comment) but dropped by
		// decode; both good entries survive.
		expect(parsed.map((e) => e.comment.id)).toEqual(['a1', 'a2']);
	});

	it('does not match a marker (annoteca/ vs annoteca:store)', () => {
		const doc = 'Prose. <!-- annoteca/tone: a body [id=a1] -->';
		expect(scanStoreEntries(doc)).toHaveLength(0);
	});

	it('reports byte ranges that cover each block exactly', () => {
		const only = block({
			id: 'a1',
			category: 'note',
			body: 'x',
			replies: [],
		});
		const doc = `lead\n${only}\ntrail`;
		const scanned = scanStoreEntries(doc);
		expect(scanned).toHaveLength(1);
		const e = scanned[0];
		if (!e) throw new Error('no entry');
		expect(doc.slice(e.start, e.end)).toBe(only);
	});
});

// Seeded property test: unlike the marker format, the store is LOSSLESS, so the
// assertion is full structural equality of decode(encode(x)) against x, not the
// one-directional "state is not lost" the marker fuzz settles for. Deterministic
// mulberry32 + literal pools, same discipline as parser-roundtrip-fuzz.
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

const SEED = 0x5eed4820;
const ITERATIONS = 5000;

// Adversarial free-text pool: every HTML-comment hazard plus the shapes that broke
// the marker format, since the store must hold them all verbatim.
const TEXT: readonly string[] = [
	'plain',
	'',
	'   ',
	'multi\nline\ntext',
	'holds an arrow --> here',
	'quotes a marker <!-- annoteca/note: inner -->',
	'unclosed opener <!-- annoteca/note: no close',
	'triple ---> and <--- back',
	'bare < and > and <!-- and --> and <>',
	'ends with a code block\n```\ncode\n```',
	'fence\n```annoteca-original\nfake\n```',
	'café 日本語 🎉 unicode',
	'CRLF\r\ninside',
	'backslash \\ and \\u003e literal and \\\\ doubled',
	'quote " and brace } and bracket ] chars',
	'[reply mallory 2020-01-01]: bracket-leading',
	'[[Some Note]] wikilink',
];

const IDS: readonly string[] = ['a3b9c2x7', 'deadbeef', '00000000', 'zzzzzzzz'];
const CATEGORIES: readonly string[] = ['note', 'tone', 'source-needed', 'a1'];
const STAMPS: readonly string[] = [
	'2020-01-01',
	'2024-06-22T14:30',
	'2026-08-04T09:15:42',
];

function pick<T>(rand: () => number, pool: readonly T[]): T {
	const value = pool[Math.floor(rand() * pool.length)];
	if (value === undefined) throw new Error('empty pool');
	return value;
}

function generate(rand: () => number): StoredComment {
	const replyCount = Math.floor(rand() * 4);
	const replies: Reply[] = [];
	for (let i = 0; i < replyCount; i++) {
		replies.push({
			author: pick(rand, TEXT) || 'user',
			date: pick(rand, STAMPS),
			body: pick(rand, TEXT),
		});
	}

	const c: StoredComment = {
		id: pick(rand, IDS),
		category: pick(rand, CATEGORIES),
		body: pick(rand, TEXT),
		replies,
	};
	if (rand() < 0.7) c.date = pick(rand, STAMPS);
	if (rand() < 0.7) c.author = pick(rand, TEXT) || 'user';
	if (rand() < 0.5) {
		const anchor: AnchorText = {
			text: pick(rand, TEXT),
			truncated: rand() < 0.5,
		};
		c.anchor = anchor;
	}
	if (rand() < 0.4) {
		c.addressed = {
			author: pick(rand, TEXT) || 'user',
			date: pick(rand, STAMPS),
			note: pick(rand, TEXT),
			...(rand() < 0.7 ? { original: pick(rand, TEXT) } : {}),
		};
	}
	if (rand() < 0.3) {
		c.resolution = {
			author: pick(rand, TEXT) || 'user',
			date: pick(rand, STAMPS),
			note: pick(rand, TEXT),
		};
	}
	// Only ever set unknownLines when non-empty, matching how encode omits an empty
	// one, so the generated input is already in round-trip-normal form.
	if (rand() < 0.2) {
		c.unknownLines = ['[retry=3]', '[priority=high]'].slice(
			0,
			1 + Math.floor(rand() * 2),
		);
	}
	return c;
}

describe('store: encode/decode is lossless (seeded fuzz)', () => {
	it('decode(encode(x)) equals x over 5,000 generated comments', () => {
		const rand = mulberry32(SEED);
		for (let i = 0; i < ITERATIONS; i++) {
			const input = generate(rand);
			const block = encodeStoreEntry(input);
			const context = `iteration ${i}\ninput: ${JSON.stringify(input)}\nblock: ${block}`;

			// The payload never carries an angle bracket, so the wrapper is always
			// closed by its own terminator.
			const scanned = scanStoreEntries(block);
			if (scanned.length !== 1)
				throw new Error(
					`${context}\nexpected 1 block, got ${scanned.length}`,
				);
			const raw = scanned[0];
			if (!raw) throw new Error(context);
			if (raw.json.includes('<') || raw.json.includes('>'))
				throw new Error(`${context}\npayload holds an angle bracket`);

			const out = decodeStoreEntry(raw.json);
			if (out === undefined)
				throw new Error(`${context}\ndecoded undefined`);
			expect(out).toEqual(input);
		}
	});
});
