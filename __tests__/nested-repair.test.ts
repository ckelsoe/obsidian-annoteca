// Notes damaged before 1.27.2, rebuilt here the way the old writers damaged
// them, at every offset they could, and repaired. The old composer planned a
// new marker at the cursor with planMarkerInsert and spliced it in without
// asking whether the spot was inside something; the old planCloser could put
// a closer inside a store entry.

import { hasRepairableNesting, repairNestedMarkers } from '../nested-repair';
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
});
