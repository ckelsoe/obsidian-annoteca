// Notes damaged before 1.27.2, rebuilt here the way the old writers damaged
// them, at every offset they could, and repaired. The old composer planned a
// new marker at the cursor with planMarkerInsert and spliced it in without
// asking whether the spot was inside something; the old planCloser could put
// a closer inside a store entry.

import {
	hasRepairableNesting,
	repairNestedMarkers,
	repairWhole,
} from '../nested-repair';
import { enclosingForbidden } from '../forbidden';
import { layoutMarker, planMarkerInsert } from '../marker-placement';
import {
	findMalformedMarkers,
	parseAll,
	serialize,
	serializeCloser,
	serializeLeanMarker,
} from '../parser';
import { frontmatterEnd } from '../range-placement';
import {
	decodeStoreEntry,
	encodeStoreEntry,
	parseStore,
	scanStoreEntries,
	writeStoreRegion,
} from '../store';
import type { Comment } from '../types';

const PROPS = '---\ntitle: Note\ntags: [a, b]\n---\n';

const FIRST = serialize({
	id: 'aaaaaaaa',
	category: 'clarify',
	body: 'first comment body',
	date: '2026-10-01T10:00:00',
	author: 'ed',
	anchor: { text: 'Some prose', truncated: false },
	range: 'closed',
	replies: [{ author: 'kilo', date: '2026-10-02T10:00:00', body: 'a reply' }],
});
const SECOND = serialize({
	id: 'bbbbbbbb',
	category: 'tone',
	body: 'second',
	date: '2026-10-01T11:00:00',
	author: 'ed',
});

// A body with every line shape the old planner treats specially: a line
// ending in a space, a list item, a quote and a heading.
const THIRD = serialize({
	id: 'tttttttt',
	category: 'clarify',
	body: 'line with space \nnext\n- item\n> quoted\n# heading',
	date: '2026-10-01T12:00:00',
	author: 'ed',
});

const INLINE_NOTE =
	`${PROPS}\n${FIRST}\nSome prose here.${serializeCloser('aaaaaaaa')}\n\n` +
	`- item ${SECOND} with text\n\n${THIRD}\nTail paragraph.\n`;

const EOF_NOTE =
	`Intro line ${serializeLeanMarker('clarify', 'cccccccc')} text.\n\n` +
	encodeStoreEntry({
		id: 'cccccccc',
		category: 'clarify',
		body: 'stored body\nwith two lines',
		date: '2026-10-01T10:00:00',
		author: 'ed',
		replies: [],
	}) +
	'\n';

const NEW_FULL = serialize({
	id: 'nnnnnnnn',
	category: 'clarify',
	body: 'the new one',
	date: '2026-10-17T12:00:00',
	author: 'ed',
});
const NEW_LEAN = serializeLeanMarker('clarify', 'nnnnnnnn');
// A comment made on a selection carries the text it was made on.
const NEW_SELECTED = serialize({
	id: 'nnnnnnnn',
	category: 'clarify',
	body: 'the new one',
	date: '2026-10-17T12:00:00',
	author: 'ed',
	anchor: { text: 'picked', truncated: false },
});

// What the old composer did with a bare cursor (inline '') and a selection
// (inline ' ').
function oldInsert(
	content: string,
	cursor: number,
	text: string,
	inline: string,
): string {
	const place = planMarkerInsert(content, cursor, text.includes('\n'));
	return (
		content.slice(0, place.at) +
		layoutMarker(place, text, inline) +
		content.slice(place.at)
	);
}

// A comment as the reader sees it: everything but where it sits. A space at
// the end of a line is left out: `word <m>` then a line break is the same
// bytes whether the marker followed `word ` or was appended to `word`, so the
// repair can lose that one unrendered space (see withouts in nested-repair).
function shape(c: Comment): string {
	const { marker: _m, closer: _k, ...rest } = c;
	let out = JSON.stringify(rest);
	while (out.includes(' \\n')) out = out.split(' \\n').join('\\n');
	return out;
}
const comments = (content: string): Map<string, string> =>
	new Map(
		parseAll(content)
			.filter((c) => c.id !== undefined)
			.map((c) => [c.id ?? '', shape(c)]),
	);

function healthy(content: string): void {
	expect(
		findMalformedMarkers(content).filter((f) => f.kind !== 'malformed'),
	).toEqual([]);
	for (const e of scanStoreEntries(content))
		expect(decodeStoreEntry(e.json)).toBeDefined();
	for (const c of parseAll(content))
		expect(
			enclosingForbidden(
				content.slice(0, c.marker.start) + content.slice(c.marker.end),
				c.marker.start,
			),
		).toBeUndefined();
}

// Every offset where the old composer wrote into something.
function damagedOffsets(content: string): number[] {
	const out: number[] = [];
	for (let i = 0; i <= content.length; i++)
		if (enclosingForbidden(content, i) !== undefined) out.push(i);
	return out;
}

// A full comment, and a store entry, for building split-store notes.
const newMarker = (id: string): string =>
	serialize({
		id,
		category: 'clarify',
		body: 'new',
		date: '2026-10-17T12:00:00',
	});
const plainEntry = (id: string): string =>
	encodeStoreEntry({
		id,
		category: 'clarify',
		body: 'x',
		date: '2026-10-17T12:00:00',
		replies: [],
	});

describe('repairNestedMarkers', () => {
	it('answers whether a note needs the repair without running it all', () => {
		expect(hasRepairableNesting(INLINE_NOTE)).toBe(false);
		const damaged = oldInsert(
			INLINE_NOTE,
			INLINE_NOTE.indexOf('first comment body') + 3,
			NEW_FULL,
			'',
		);
		expect(hasRepairableNesting(damaged)).toBe(true);
	});

	it('leaves a healthy note alone', () => {
		expect(repairNestedMarkers(INLINE_NOTE)).toEqual({
			updated: INLINE_NOTE,
			converted: 0,
		});
		expect(repairNestedMarkers(EOF_NOTE)).toEqual({
			updated: EOF_NOTE,
			converted: 0,
		});
	});

	it('restores every comment exactly after a cursor comment landed inside a marker, a closer or the properties', () => {
		const before = comments(INLINE_NOTE);
		const offsets = damagedOffsets(INLINE_NOTE);
		expect(offsets.length).toBeGreaterThan(100);
		for (const at of offsets) {
			const damaged = oldInsert(INLINE_NOTE, at, NEW_FULL, '');
			const { updated, converted } = repairNestedMarkers(damaged);
			try {
				expect(converted).toBe(1);
				healthy(updated);
				const after = comments(updated);
				for (const [id, s] of before) expect(after.get(id)).toBe(s);
				expect(after.get('nnnnnnnn')).toBe(
					shape(parseAll(NEW_FULL)[0] as Comment),
				);
				expect(updated.slice(0, frontmatterEnd(updated))).toBe(PROPS);
			} catch (e) {
				throw new Error(
					`offset ${at}: ${JSON.stringify(damaged)}\n${String(e)}`,
				);
			}
		}
	});

	it('restores every comment exactly after a selection comment landed inside one', () => {
		const before = comments(INLINE_NOTE);
		for (const at of damagedOffsets(INLINE_NOTE)) {
			const damaged = oldInsert(INLINE_NOTE, at, NEW_SELECTED, ' ');
			const { updated, converted } = repairNestedMarkers(damaged);
			try {
				expect(converted).toBe(1);
				healthy(updated);
				const after = comments(updated);
				for (const [id, s] of before) expect(after.get(id)).toBe(s);
				expect(after.has('nnnnnnnn')).toBe(true);
				expect(updated.slice(0, frontmatterEnd(updated))).toBe(PROPS);
			} catch (e) {
				throw new Error(
					`offset ${at}: ${JSON.stringify(damaged)}\n${String(e)}`,
				);
			}
		}
	});

	it('restores the store entry after a marker landed inside it', () => {
		const entry = parseStore(EOF_NOTE)[0]?.comment;
		for (const at of damagedOffsets(EOF_NOTE)) {
			for (const [lean, selected] of [
				[false, false],
				[true, false],
				[true, true],
			]) {
				// A lean marker came with its store entry, written by the old
				// composer straight after the marker, the same way. One made
				// on a selection had a space after it and its anchor stored.
				const afterMarker = oldInsert(
					EOF_NOTE,
					at,
					lean ? NEW_LEAN : NEW_FULL,
					selected ? ' ' : '',
				);
				const damaged = lean
					? writeStoreRegion(afterMarker, [
							...parseStore(afterMarker).map((e) => e.comment),
							{
								id: 'nnnnnnnn',
								category: 'clarify',
								body: 'the new one',
								date: '2026-10-17T12:00:00',
								author: 'ed',
								replies: [],
								...(selected
									? {
											anchor: {
												text: 'picked',
												truncated: false,
											},
										}
									: {}),
							},
						])
					: afterMarker;
				const { updated, converted } = repairNestedMarkers(damaged);
				try {
					expect(converted).toBe(1);
					healthy(updated);
					expect(
						parseStore(updated).find(
							(e) => e.comment.id === 'cccccccc',
						)?.comment,
					).toEqual(entry);
					expect(parseAll(updated).map((c) => c.id)).toContain(
						'nnnnnnnn',
					);
				} catch (e) {
					throw new Error(
						`offset ${at}: ${JSON.stringify(damaged)}\n${String(e)}`,
					);
				}
			}
		}
	});

	it('moves a closer out of a store entry to the end of its passage', () => {
		const note =
			`${serialize({ id: 'dddddddd', category: 'clarify', body: 'x', range: 'closed' })} Passage text.\n\n` +
			encodeStoreEntry({
				id: 'eeeeeeee',
				category: 'tone',
				body: 'kept',
				replies: [],
			}) +
			'\n';
		const store = scanStoreEntries(note)[0];
		if (!store) throw new Error('no store');
		for (let at = store.start + 1; at < store.end; at++) {
			const damaged =
				note.slice(0, at) +
				serializeCloser('dddddddd') +
				note.slice(at);
			const { updated, converted } = repairNestedMarkers(damaged);
			expect(converted).toBe(1);
			healthy(updated);
			expect(updated).toContain(
				`Passage text.${serializeCloser('dddddddd')}\n\n<!-- annoteca:store`,
			);
		}
	});

	it('lifts a comment written before the properties to just after them', () => {
		const damaged = `${NEW_FULL}\n${PROPS}Body.\n`;
		const { updated, converted } = repairNestedMarkers(damaged);
		expect(converted).toBe(1);
		expect(updated.startsWith(PROPS)).toBe(true);
		expect(comments(updated).has('nnnnnnnn')).toBe(true);
	});

	it('does not lift an id-less quote out of a legacy body', () => {
		// Written before serialize() escaped `<!--`: the body quotes a bare
		// example marker. Same bytes as damage, so it is left for the user.
		const legacy =
			'<!-- annoteca/clarify: write it as <!-- annoteca/todo: x --> like that\n[id=ffffffff]\n-->\n';
		expect(repairNestedMarkers(legacy).converted).toBe(0);
	});

	it('does not split a legacy comment that quotes a whole marker, id and date included', () => {
		// The same bytes as a comment nested by the bug, but the quoted
		// marker is dated before 1.14.0 escaped `<!--`, so it can only be a
		// quote: the plugin wrote no unescaped opener after that day.
		const quoted = serialize({
			id: 'qqqqqqqq',
			category: 'todo',
			body: 'example',
			date: '2026-07-01T09:00:00',
			author: 'ed',
		});
		const legacy = `<!-- annoteca/clarify: the format looks like ${quoted} which is handy\n[id=ffffffff]\n[date=2026-07-01T09:05:00]\n-->\nProse.\n`;
		expect(repairNestedMarkers(legacy)).toEqual({
			updated: legacy,
			converted: 0,
		});
	});

	it('does not lift a lean marker whose stored date is before the escape', () => {
		const note =
			`<!-- annoteca/clarify: see ${serializeLeanMarker('todo', 'llllllll')} here\n[id=ffffffff]\n[date=2026-07-01]\n-->\nProse.\n\n` +
			encodeStoreEntry({
				id: 'llllllll',
				category: 'todo',
				body: 'old',
				date: '2026-07-01',
				replies: [],
			}) +
			'\n';
		expect(repairNestedMarkers(note).converted).toBe(0);
	});

	it('leaves a dateless legacy quote that has an id alone', () => {
		// Codex's reproduction: an id but no date, so not written by a
		// version that could have nested it.
		const legacy =
			'<!-- annoteca/clarify: write <!-- annoteca/todo: x\n[id=ffffffff]\n-->\n';
		expect(repairNestedMarkers(legacy).converted).toBe(0);
	});

	it('gives a host its list item and its line-end space back', () => {
		for (const [body, word] of <[string, string][]>[
			['line\n- item', 'item'],
			['line with space \nnext', 'next'],
		]) {
			const host = serialize({
				id: 'hhhhhhhh',
				category: 'tone',
				body,
				date: '2026-10-01T10:00:00',
				author: 'ed',
			});
			const note = `Intro.\n\n${host}\nProse.\n`;
			const damaged = oldInsert(note, note.indexOf(word), NEW_FULL, '');
			expect(repairNestedMarkers(damaged).updated).toContain(host);
		}
	});

	it('rejoins a store entry that a closer split, after the store was rewritten', () => {
		const note =
			`${serializeLeanMarker('clarify', 'dddddddd')} Passage text.\n\n` +
			writeStoreRegion('', [
				{
					id: 'eeeeeeee',
					category: 'tone',
					body: 'kept',
					replies: [],
				},
				{
					id: 'dddddddd',
					category: 'clarify',
					body: 'x',
					date: '2026-10-17T12:00:00',
					range: 'closed',
					replies: [],
				},
			]);
		const store = scanStoreEntries(note)[0];
		if (!store) throw new Error('no store');
		for (let at = store.start + 1; at < store.end; at++) {
			const inserted =
				note.slice(0, at) +
				serializeCloser('dddddddd') +
				note.slice(at);
			const damaged = writeStoreRegion(
				inserted,
				parseStore(inserted).map((e) => e.comment),
			);
			const { updated, converted } = repairNestedMarkers(damaged);
			try {
				expect(converted).toBe(1);
				healthy(updated);
				expect(
					parseStore(updated)
						.map((e) => e.comment.id)
						.sort(),
				).toEqual(['dddddddd', 'eeeeeeee']);
				expect(updated).toContain(
					`Passage text.${serializeCloser('dddddddd')}`,
				);
			} catch (e) {
				throw new Error(
					`offset ${at}: ${JSON.stringify(damaged)}\n${String(e)}`,
				);
			}
		}
	});

	it.each([
		['a blank line', '---\ntitle: Note\n\ndescription: text\n---\n'],
		[
			'a key that starts with dashes',
			'---\n---custom: value\ntitle: Note\n---\n',
		],
	])(
		'repairs properties holding %s, at every offset in them',
		(_what, props) => {
			const note = `${props}Body.\n`;
			for (let at = 0; at < props.length; at++) {
				if (enclosingForbidden(note, at) === undefined) continue;
				const damaged = oldInsert(note, at, NEW_FULL, '');
				const { updated, converted } = repairNestedMarkers(damaged);
				try {
					expect(converted).toBe(1);
					expect(updated.slice(0, frontmatterEnd(updated))).toBe(
						props,
					);
					expect(comments(updated).has('nnnnnnnn')).toBe(true);
				} catch (e) {
					throw new Error(
						`offset ${at}: ${JSON.stringify(damaged)}\n${String(e)}`,
					);
				}
			}
		},
	);

	it('lifts a closer written into a marker back out after it', () => {
		const opener = serialize({
			id: 'aaaaaaaa',
			category: 'clarify',
			body: 'range',
			date: '2026-10-17T12:00:00',
			range: 'closed',
		});
		const host = serialize({
			id: 'bbbbbbbb',
			category: 'tone',
			body: 'kept',
			date: '2026-10-01T10:00:00',
		});
		const at = host.indexOf('kept') + 2;
		const damaged = `${opener} Passage ${host.slice(0, at)}${serializeCloser('aaaaaaaa')}${host.slice(at)}\nTail.\n`;
		const { updated, converted } = repairNestedMarkers(damaged);
		expect(converted).toBe(1);
		healthy(updated);
		expect(updated).toContain(`${host}${serializeCloser('aaaaaaaa')}`);
	});

	it('reads the ambiguous `word <m> ` + newline as a comment from the next line', () => {
		// The same bytes come from a cursor between the two spaces of a hard
		// break, which a click cannot produce. The likelier reading is pinned.
		const host = serialize({
			id: 'hhhhhhhh',
			category: 'tone',
			body: 'line \nnext',
			date: '2026-10-01T10:00:00',
		});
		const note = `Intro.\n\n${host}\nProse.\n`;
		const damaged = oldInsert(note, note.indexOf('next'), NEW_FULL, '');
		expect(damaged).toContain(`line ${NEW_FULL} \nnext`);
		expect(repairNestedMarkers(damaged).updated).toContain(host);
	});

	it('repairs a comment written inside one that was itself inside the properties', () => {
		// Lifting the inner comment makes the outer one readable, and it is in
		// the properties too, so it is lifted next. Both end up below them.
		const marker = (id: string, body: string): string =>
			`<!-- annoteca/todo: ${body}\n[id=${id}]\n[date=2026-10-17]\n-->`;
		const outer = marker('aaaaaaaa', 'outer');
		const at = outer.indexOf('todo') + 2;
		const note = `---\ntitle: ${outer.slice(0, at)}${marker('bbbbbbbb', 'inner')}${outer.slice(at)}hello\n---\nprose`;
		const { updated, converted } = repairNestedMarkers(note);
		expect(converted).toBe(2);
		healthy(updated);
		expect(updated.startsWith('---\ntitle: hello\n---\n')).toBe(true);
		expect(
			parseAll(updated)
				.map((c) => c.id)
				.sort(),
		).toEqual(['aaaaaaaa', 'bbbbbbbb']);
	});

	it('rejoins several store entries that closers split, one rewrite after another', () => {
		// Each closer went into a store entry and the store was rewritten
		// before the next. Taking a closer out of the first broken entry runs
		// it on into the next one, which counts as one broken entry where
		// there were two: that must not pass for progress.
		const ids = ['d0000000', 'd0000001', 'd0000002'];
		let note = writeStoreRegion(
			ids
				.map(
					(id, i) =>
						`Para ${i} ${serializeLeanMarker('clarify', id)} text.\n\n`,
				)
				.join(''),
			ids.map((id) => ({
				id,
				category: 'clarify',
				body: 'x',
				date: '2026-10-17T12:00:00',
				range: 'closed' as const,
				replies: [],
			})),
		);
		for (const [k, id] of ['d0000002', 'd0000000', 'd0000001'].entries()) {
			const whole = scanStoreEntries(note).filter(
				(e) => decodeStoreEntry(e.json) !== undefined,
			);
			const e = whole[k % whole.length];
			if (!e) throw new Error('no entry');
			const at = note.indexOf('{\n', e.start) + 2;
			const inserted =
				note.slice(0, at) + serializeCloser(id) + note.slice(at);
			note = writeStoreRegion(
				inserted,
				parseStore(inserted).map((x) => x.comment),
			);
		}
		const { updated, converted } = repairNestedMarkers(note);
		expect(converted).toBe(3);
		healthy(updated);
		expect(
			parseStore(updated)
				.map((e) => e.comment.id)
				.sort(),
		).toEqual(ids);
		for (const id of ids) expect(updated).toContain(serializeCloser(id));
		expect(updated.indexOf('"v"')).toBeGreaterThan(
			updated.indexOf('<!-- annoteca:store'),
		);
	});

	it('repairs closers and markers split into several store entries at random offsets', () => {
		// The old writers, in turn: a range comment whose closer went into a
		// store entry, then the store rewritten with its own entry; or a
		// comment written into a store entry, rewritten or not. Seeds 11 and
		// 15 reach the notes a stretch-by-stretch rejoin paired wrongly
		// (11, round 424) and a join that made up an id (15, round 20).
		for (const seed of [11, 15]) {
			const next = rng(seed);
			for (let round = 0; round < 500; round++) {
				const base = ['e0000000', 'e0000001'].map(
					(id) => `${id}${round}`,
				);
				let note = writeStoreRegion(
					base
						.map(
							(id, i) =>
								`Para ${i} ${serializeLeanMarker('clarify', id)} text.\n\n`,
						)
						.join(''),
					base.map((id) => ({
						id,
						category: 'clarify',
						body: 'x',
						date: '2026-10-17T12:00:00',
						replies: [],
					})),
				);
				const all = [...base];
				const hits = 1 + Math.floor(next() * 4);
				for (let k = 0; k < hits; k++) {
					const whole = scanStoreEntries(note).filter(
						(e) => decodeStoreEntry(e.json) !== undefined,
					);
					const e = whole[Math.floor(next() * whole.length)];
					if (!e) break;
					const at =
						e.start +
						1 +
						Math.floor(next() * (e.end - e.start - 1));
					const id = `n${String(round * 10 + k).padStart(7, '0')}`;
					all.push(id);
					if (next() < 0.6) {
						// A range comment on a new paragraph, its closer astray.
						const para = note.indexOf('\n\n<!-- annoteca:store');
						const withCloser =
							note.slice(0, at) +
							serializeCloser(id) +
							note.slice(at);
						const marked =
							withCloser.slice(0, para) +
							`\n\nNew ${k} ${serializeLeanMarker('clarify', id)} words.` +
							withCloser.slice(para);
						note = writeStoreRegion(marked, [
							...parseStore(marked).map((x) => x.comment),
							{
								id,
								category: 'clarify',
								body: 'r',
								date: '2026-10-17T12:00:00',
								range: 'closed' as const,
								replies: [],
							},
						]);
					} else {
						note = oldInsert(
							note,
							at,
							serialize({
								id,
								category: 'clarify',
								body: 'new',
								date: '2026-10-17T12:00:00',
							}),
							'',
						);
						if (next() < 0.5)
							note = writeStoreRegion(
								note,
								parseStore(note).map((x) => x.comment),
							);
					}
				}
				const { updated } = repairNestedMarkers(note);
				try {
					healthy(updated);
					const kept = new Set([
						...parseStore(updated).map((x) => x.comment.id),
						...parseAll(updated).map((c) => c.id),
					]);
					for (const id of all) expect(kept.has(id)).toBe(true);
					// No entry under an id the note never had.
					for (const x of parseStore(updated))
						expect(all).toContain(x.comment.id);
					expect(
						parseStore(updated).filter((x) =>
							base.includes(x.comment.id),
						),
					).toHaveLength(base.length);
				} catch (err) {
					throw new Error(`${JSON.stringify(note)}\n${String(err)}`);
				}
			}
		}
	});

	it('does not let a full comment with a made-up id pull two store entries together wrongly', () => {
		// Each entry cut inside its id: `a` + `bbbbbbb"` reads as abbbbbbb,
		// which a full comment in the note happens to carry. Only a lean
		// marker waiting for its entry vouches for an id.
		const a = plainEntry('aaaaaaaa');
		const b = plainEntry('bbbbbbbb');
		const i = a.indexOf('aaaaaaaa') + 1;
		const j = b.indexOf('bbbbbbbb') + 1;
		const note =
			newMarker('abbbbbbb') +
			'\n\n' +
			a.slice(i) +
			'\n\n' +
			b.slice(j) +
			'\n\n' +
			a.slice(0, i) +
			newMarker('nnnnnnn1') +
			'\n' +
			b.slice(0, j) +
			newMarker('nnnnnnn2') +
			'\n';
		const { updated } = repairNestedMarkers(note);
		expect(
			parseStore(updated)
				.map((x) => x.comment.id)
				.sort(),
		).toEqual(['aaaaaaaa', 'bbbbbbbb']);
	});

	it.each([
		['as written', (id: string) => `<!-- annoteca/clarify: [id=${id}] -->`],
		[
			'broken over lines',
			(id: string) => `<!-- annoteca/clarify\n: [id=${id}] -->`,
		],
	])(
		'gives each lean marker (%s) its own entry back when the halves could cross',
		(_name, lean) => {
			// Each entry cut inside its id, so `a` + `bbbbbbb"` also decodes.
			const a = plainEntry('aaaaaaaa');
			const b = plainEntry('bbbbbbbb');
			const i = a.indexOf('aaaaaaaa') + 1;
			const j = b.indexOf('bbbbbbbb') + 1;
			const note =
				lean('aaaaaaaa') +
				'\n' +
				lean('bbbbbbbb') +
				'\n\n' +
				b.slice(j) +
				'\n\n' +
				a.slice(i) +
				'\n\n' +
				a.slice(0, i) +
				newMarker('nnnnnnn1') +
				'\n' +
				b.slice(0, j) +
				newMarker('nnnnnnn2') +
				'\n';
			const { updated } = repairNestedMarkers(note);
			expect(
				parseStore(updated)
					.map((x) => x.comment.id)
					.sort(),
			).toEqual(['aaaaaaaa', 'bbbbbbbb']);
		},
	);

	it('rejoins a hand-edited store entry whose JSON holds a blank line', () => {
		const entry = encodeStoreEntry({
			id: 'eeeeeeee',
			category: 'tone',
			body: 'kept',
			replies: [],
		}).replace('{\n', '{\n\n');
		const note =
			`${serializeLeanMarker('clarify', 'dddddddd')} Passage text.\n\n` +
			writeStoreRegion('', [
				{
					id: 'dddddddd',
					category: 'clarify',
					body: 'x',
					date: '2026-10-17T12:00:00',
					range: 'closed',
					replies: [],
				},
			]) +
			'\n' +
			entry +
			'\n';
		const at =
			note.lastIndexOf('<!-- annoteca:store') +
			'<!-- annoteca:store'.length;
		const inserted =
			note.slice(0, at) + serializeCloser('dddddddd') + note.slice(at);
		const damaged = writeStoreRegion(
			inserted,
			parseStore(inserted).map((e) => e.comment),
		);
		const { updated, converted } = repairNestedMarkers(damaged);
		expect(converted).toBe(1);
		expect(
			parseStore(updated)
				.map((e) => e.comment.id)
				.sort(),
		).toEqual(['dddddddd', 'eeeeeeee']);
	});

	// The plain walk: one lift at a time over the whole note, no chain pass.
	const plain = (note: string) => repairWhole(note, undefined, false);
	const same = (note: string, got: unknown, want: unknown): void => {
		if (JSON.stringify(got) !== JSON.stringify(want))
			throw new Error(JSON.stringify({ note, got, want }));
	};
	const rng = (start: number): (() => number) => {
		let seed = start;
		return () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
	};

	it('repairs stretch by stretch exactly as a lift at a time over the whole note', () => {
		// Several damaged spots at once, each made the way the old composer
		// made them, at random places in a note with properties and a store.
		const next = rng(5);
		for (let round = 0; round < 150; round++) {
			let note = EOF_NOTE.replace(
				'Intro line',
				`${PROPS}\n${INLINE_NOTE}\nIntro line`,
			);
			const spots = 1 + Math.floor(next() * 4);
			for (let k = 0; k < spots; k++) {
				const offsets = damagedOffsets(note);
				const at = offsets[Math.floor(next() * offsets.length)];
				if (at === undefined) break;
				const text = serialize({
					id: `n${String(round * 10 + k).padStart(7, '0')}`,
					category: 'clarify',
					body: 'new',
					date: '2026-10-17T12:00:00',
				});
				note = oldInsert(note, at, text, '');
			}
			same(note, repairNestedMarkers(note), plain(note));
		}
	});

	it('never starts a stretch at a `---` line, which read alone would be properties', () => {
		const m = (id: string, body: string): string =>
			serialize({ id, body, category: 'note', date: '2026-10-01' });
		const d = (a: string, b: string): string =>
			m(a, 'host').replace('host', `ho${m(b, 'new')}st`);
		const note = `text\n---\nIntro\n${d('aaaaaaaa', 'bbbbbbbb')}\n---\n${d('cccccccc', 'dddddddd')}`;
		same(note, repairNestedMarkers(note), plain(note));
	});

	it('lifts a chain of comments written into one comment as the plain walk does', () => {
		const next = rng(9);
		const gaps = [
			'',
			' ',
			'word ',
			'\n',
			'\n\n',
			'\nline\n',
			' more text\n- item ',
			'\n> q ',
			'\nTAIL',
			'\n\n\nx ',
			// Long lines, which a stretch keeps only the ends of.
			`${'long words '.repeat(60)}`,
			`\n${'y'.repeat(700)} `,
		];
		const leads = [
			'',
			'Para text ',
			'- ',
			'> ',
			'# Head ',
			`${'lead '.repeat(150)}`,
		];
		for (let round = 0; round < 3000; round++) {
			const n = 2 + Math.floor(next() * 11);
			let body = 'host';
			for (let i = 0; i < n; i++) {
				const piece = serialize({
					id: `c${String(round * 100 + i).padStart(7, '0')}`,
					category: 'clarify',
					body: 'new',
					date: '2026-10-17T12:00:00',
					...(next() < 0.3
						? { anchor: { text: 'picked', truncated: false } }
						: {}),
				});
				body += `${piece}${gaps[Math.floor(next() * gaps.length)] ?? ''}`;
			}
			const host = serialize({
				id: `h${String(round).padStart(7, '0')}`,
				category: 'tone',
				body: 'x',
				date: '2026-10-01T10:00:00',
			}).replace('x', body);
			const lead = leads[Math.floor(next() * leads.length)] ?? '';
			const note = `Intro.\n\n${lead}${host}\nAfter.\n`;
			same(note, repairNestedMarkers(note), plain(note));
		}
	});

	it("keeps the plain walk's layout under a long list prefix", () => {
		const m = (id: string, body: string): string =>
			serialize({ id, body, category: 'note', date: '2026-10-01' });
		let note = `- ${' '.repeat(513)}${m('hhhhhhhh', 'hostTAIL')}`;
		for (const id of ['aaaaaaaa', 'bbbbbbbb'])
			note = oldInsert(note, note.indexOf('TAIL'), m(id, 'new'), '');
		same(note, repairNestedMarkers(note), plain(note));
	});

	it('does not treat a non-breaking space as JSON whitespace when rejoining', () => {
		const stored = encodeStoreEntry({
			id: 'eeeeeeee',
			category: 'tone',
			body: 'kept',
			replies: [],
		});
		const note = `${serializeLeanMarker('clarify', 'dddddddd')} Passage.\n\n\u00a0\n\n${stored}\n`;
		const at = note.indexOf('{\n') + 2;
		const inserted =
			note.slice(0, at) + serializeCloser('dddddddd') + note.slice(at);
		const damaged = writeStoreRegion(
			inserted,
			parseStore(inserted).map((e) => e.comment),
		);
		// The plain walk shares the rejoin, so the entry itself is checked.
		const { updated, converted } = repairNestedMarkers(damaged);
		expect(converted).toBe(1);
		expect(parseStore(updated).map((e) => e.comment.id)).toContain(
			'eeeeeeee',
		);
	});

	it('lifts chains in two neighbouring comments as the plain walk does', () => {
		const m = (id: string, body: string): string =>
			serialize({ id, body, category: 'note', date: '2026-10-01' });
		const chained = (h: string, n: number): string => {
			let body = 'host';
			for (let i = 0; i < n; i++)
				body += m(`${h}${String(i).padStart(4, '0')}`, 'new');
			return m(`${h}0host`, 'X').replace('X', body);
		};
		const note = `Intro.\n${chained('aaa', 6)}\n${chained('bbb', 6)}\nAfter.\n`;
		const got = repairNestedMarkers(note);
		same(note, got, plain(note));
		expect(got.converted).toBe(12);
	});

	it('reaches past the line after every comment a stretch lifts, not only its own', () => {
		const m = (id: string, body: string): string =>
			serialize({ id, body, category: 'note', date: '2026-10-01' });
		const put = (note: string, at: number, id: string): string =>
			oldInsert(note, at, m(id, 'new'), '');
		let note = m('hhhhhhhh', 'host\n> > word - TAIL');
		for (const id of ['aaaaaaaa', 'bbbbbbbb'])
			note = put(note, note.indexOf('\n> > word') + 3, id);
		note = put(note, note.indexOf('word'), 'cccccccc');
		for (const id of ['dddddddd', 'eeeeeeee', 'ffffffff'])
			note = put(note, note.indexOf('- TAIL'), id);
		same(note, repairNestedMarkers(note), plain(note));
	});
});
