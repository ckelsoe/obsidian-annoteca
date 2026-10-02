// #84 follow-up: a comment made with a closer carries `[range=closed]`, so a
// closer that later goes missing can be reported. These pin the flag through
// every place a comment is read, written or moved between storage modes, and
// the report it exists for.

import { parseAll, serialize, serializeCloser } from '../parser';
import {
	parseDocument,
	convertFileToEof,
	convertFileToInline,
	isLeanMarker,
} from '../document';
import { decodeStoreEntry, encodeStoreEntry } from '../store';
import { detectRangeIssues } from '../diagnostics';
import type { Comment } from '../types';

const only = (doc: string): Comment => {
	const cs = parseAll(doc);
	expect(cs).toHaveLength(1);
	const c = cs[0];
	if (!c) throw new Error('no comment');
	return c;
};

const flagged = (id: string) =>
	serialize({ id, category: 'clarify', body: 'note', range: 'closed' });

describe('the [range=closed] line', () => {
	it('is written after the anchor and before any reply', () => {
		const text = serialize({
			id: 'aaaa0001',
			category: 'clarify',
			body: 'note',
			anchor: { text: 'the passage', truncated: false },
			range: 'closed',
			replies: [{ author: 'ai', date: '2026-10-02', body: 'ok' }],
		});
		const lines = text.split('\n');
		const at = lines.indexOf('[range=closed]');
		expect(at).toBe(lines.indexOf('[anchor=the passage]') + 1);
		expect(lines[at + 1]).toBe('[reply ai 2026-10-02]: ok');
	});

	it('round-trips, and is absent on a start-only comment', () => {
		expect(only(flagged('aaaa0001')).range).toBe('closed');
		const plain = serialize({
			id: 'aaaa0001',
			category: 'clarify',
			body: 'n',
		});
		expect(only(plain).range).toBeUndefined();
		expect(plain).not.toContain('[range=');
	});

	it('is not body text, and an unknown value is kept as an unknown line', () => {
		const c = only(flagged('aaaa0001'));
		expect(c.body).toBe('note');
		const odd =
			'<!-- annoteca/clarify: note\n[id=aaaa0001]\n[range=open]\n-->';
		const o = only(odd);
		expect(o.range).toBeUndefined();
		expect(o.unknownLines).toEqual(['[range=open]']);
		expect(serialize(o)).toContain('[range=open]');
	});
});

describe('the flag in end-of-file storage', () => {
	const stored = {
		id: 'aaaa0001',
		category: 'clarify',
		body: 'note',
		replies: [],
		range: 'closed' as const,
	};
	const json = (entry: string) =>
		entry.replace(/^<!-- annoteca:store\n/, '').replace(/\n-->$/, '');

	it('is written as its marker line, which an older build carries verbatim', () => {
		const entry = encodeStoreEntry(stored);
		expect(entry).toContain('[range=closed]');
		expect(entry).not.toContain('"range"');
		expect(decodeStoreEntry(json(entry))?.range).toBe('closed');
		expect(decodeStoreEntry(json(entry))?.unknownLines).toBeUndefined();
	});

	it('accepts an explicit "range": "closed" and rejects any other value', () => {
		const base = { v: 1, id: 'aaaa0001', category: 'clarify', body: 'n' };
		expect(
			decodeStoreEntry(JSON.stringify({ ...base, range: 'closed' }))
				?.range,
		).toBe('closed');
		expect(
			decodeStoreEntry(JSON.stringify({ ...base, range: 'open' })),
		).toBeUndefined();
	});

	it('survives a conversion to end-of-file storage and back', () => {
		const doc = `${flagged('aaaa0001')} Text.${serializeCloser('aaaa0001')}\n`;
		const eof = convertFileToEof(doc).updated;
		const inEof = parseDocument(eof).comments[0];
		expect(inEof?.range).toBe('closed');
		expect(inEof?.closer).toBeDefined();
		const back = convertFileToInline(eof).updated;
		expect(only(back).range).toBe('closed');
	});
});

describe('the flag is inline content', () => {
	it('a marker holding only an id and the flag is not a lean marker', () => {
		const doc =
			'<!-- annoteca/clarify:\n[id=aaaa0001]\n[range=closed]\n-->';
		const c = only(doc);
		expect(c.body).toBe('');
		expect(isLeanMarker(c)).toBe(false);
	});
});

describe('missing-closer', () => {
	const kinds = (doc: string) =>
		detectRangeIssues(doc, 'n.md').map((f) => `${f.kind}:${f.id}`);

	it('reports a flagged comment whose closer is gone', () => {
		const doc = `${flagged('aaaa0001')} Text with no closer.`;
		const found = detectRangeIssues(doc, 'n.md');
		expect(found.map((f) => f.kind)).toEqual(['missing-closer']);
		expect(found[0]?.offset).toBe(0);
	});

	it('says nothing while the closer is there', () => {
		expect(
			kinds(`${flagged('aaaa0001')} Text.${serializeCloser('aaaa0001')}`),
		).toEqual([]);
	});

	it('says nothing about a start-only comment, which never had one', () => {
		const plain = serialize({
			id: 'aaaa0001',
			category: 'clarify',
			body: 'n',
		});
		expect(kinds(`${plain} Text.`)).toEqual([]);
	});

	it('reports a misplaced closer as misplaced, not also as missing', () => {
		expect(
			kinds(`A.${serializeCloser('aaaa0001')} ${flagged('aaaa0001')} B.`),
		).toEqual(['closer-before-opener:aaaa0001']);
	});

	it('finds the flag in the store under end-of-file storage', () => {
		const doc = `${flagged('aaaa0001')} Text.${serializeCloser('aaaa0001')}\n`;
		const eof = convertFileToEof(doc).updated;
		const dropped = eof.replace(serializeCloser('aaaa0001'), '');
		expect(kinds(dropped)).toEqual(['missing-closer:aaaa0001']);
	});
});
