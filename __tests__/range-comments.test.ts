// #84: range comments. The closer grammar, how it pairs with its opener, the
// span it gives, where the composer may put one, and what the orphan check
// reports when a pairing fails.

import { parseAll, parseAt, scanClosers, serializeCloser } from '../parser';
import { parseDocument } from '../document';
import { rangeSpan } from '../view-utils';
import { detectRangeIssues } from '../diagnostics';
import { planCloser, CLOSER_REFUSED_MESSAGE } from '../range-placement';
import type { Comment } from '../types';

const opener = (id: string, body = 'note') =>
	`<!-- annoteca/clarify: ${body}\n[id=${id}]\n-->`;

const only = (doc: string): Comment => {
	const cs = parseAll(doc);
	expect(cs).toHaveLength(1);
	const c = cs[0];
	if (!c) throw new Error('no comment');
	return c;
};

const textOf = (doc: string, c: Comment): string | null => {
	const span = rangeSpan(c, (p) => doc.charAt(p));
	return span ? doc.slice(span.from, span.to) : null;
};

describe('closer grammar', () => {
	it('serializes to the documented shape', () => {
		expect(serializeCloser('a3b9c2x7')).toBe('<!-- /annoteca a3b9c2x7 -->');
	});

	it('tolerates whitespace inside, like the opener does', () => {
		const doc = `${opener('aaaa0001')} Text.<!--/annoteca   aaaa0001  -->`;
		expect(textOf(doc, only(doc))).toBe('Text.');
	});

	it('is not a marker: older parsing sees one comment, not two', () => {
		const doc = `${opener('aaaa0001')} Text.${serializeCloser('aaaa0001')}`;
		expect(parseAll(doc)).toHaveLength(1);
	});

	it('a closer quoted inside a comment body is prose, not a closer', () => {
		const doc = `${opener('aaaa0001', 'write <!-- /annoteca aaaa0001 --> here')} Text.`;
		expect(scanClosers(doc)).toEqual([]);
		expect(only(doc).closer).toBeUndefined();
	});
});

describe('pairing', () => {
	it('gives the exact span, across paragraphs', () => {
		const doc = `${opener('aaaa0001')} First para.\n\nSecond para.${serializeCloser('aaaa0001')} after`;
		expect(textOf(doc, only(doc))).toBe('First para.\n\nSecond para.');
	});

	it('pairs overlapping and nested ranges by id', () => {
		const doc =
			`${opener('aaaa0001')} one ${opener('bbbb0002')} two` +
			`${serializeCloser('aaaa0001')} three${serializeCloser('bbbb0002')}`;
		const [a, b] = parseAll(doc);
		if (!a || !b) throw new Error('two comments expected');
		expect(textOf(doc, a)).toContain('one');
		expect(textOf(doc, a)).toContain('two');
		expect(textOf(doc, b)).toContain('two');
		expect(textOf(doc, b)).toContain('three');
	});

	it('no closer: a start-only comment, exactly as before', () => {
		const doc = `${opener('aaaa0001')} Text.`;
		expect(only(doc).closer).toBeUndefined();
	});

	it('a closer above its opener does not pair', () => {
		const doc = `Before.${serializeCloser('aaaa0001')} ${opener('aaaa0001')} Text.`;
		expect(only(doc).closer).toBeUndefined();
	});

	it('two closers with one id: neither pairs', () => {
		const doc = `${opener('aaaa0001')} A.${serializeCloser('aaaa0001')} B.${serializeCloser('aaaa0001')}`;
		expect(only(doc).closer).toBeUndefined();
	});

	it('two openers with one id (a copy): neither pairs', () => {
		const doc = `${opener('aaaa0001')} A. ${opener('aaaa0001')} B.${serializeCloser('aaaa0001')}`;
		for (const c of parseAll(doc)) expect(c.closer).toBeUndefined();
	});

	it('an id-less comment never pairs', () => {
		const doc = `<!-- annoteca/clarify: no id --> Text.${serializeCloser('aaaa0001')}`;
		expect(only(doc).closer).toBeUndefined();
	});

	it('parseAt agrees with parseAll', () => {
		const doc = `${opener('aaaa0001')} Text.${serializeCloser('aaaa0001')}`;
		expect(parseAt(doc, 0)?.closer).toEqual(only(doc).closer);
	});

	it('end-of-file storage keeps the lean marker closer through the merge', () => {
		const doc =
			'<!-- annoteca/clarify: [id=aaaa0001] --> Text.' +
			`${serializeCloser('aaaa0001')}\n\n<!-- annoteca:store\n` +
			'{"v":1,"id":"aaaa0001","category":"clarify","body":"stored body","replies":[]}\n-->\n';
		const c = parseDocument(doc).comments[0];
		if (!c) throw new Error('no comment');
		expect(c.body).toBe('stored body');
		expect(textOf(doc, c)).toBe('Text.');
	});
});

describe('rangeSpan', () => {
	it('an empty range is no range', () => {
		const doc = `${opener('aaaa0001')}${serializeCloser('aaaa0001')}`;
		expect(textOf(doc, only(doc))).toBeNull();
	});

	it('without the composer space, starts right after the marker', () => {
		const doc = `${opener('aaaa0001')}Tight.${serializeCloser('aaaa0001')}`;
		expect(textOf(doc, only(doc))).toBe('Tight.');
	});
});

describe('detectRangeIssues', () => {
	const kinds = (doc: string) =>
		detectRangeIssues(doc, 'n.md').map((f) => `${f.kind}:${f.id}`);

	it('a well-formed range reports nothing', () => {
		expect(
			kinds(`${opener('aaaa0001')} T.${serializeCloser('aaaa0001')}`),
		).toEqual([]);
	});

	it('reports a closer with no comment', () => {
		expect(kinds(`Text.${serializeCloser('zzzz0009')}`)).toEqual([
			'orphaned-closer:zzzz0009',
		]);
	});

	it('reports a closer above its comment', () => {
		expect(
			kinds(`A.${serializeCloser('aaaa0001')} ${opener('aaaa0001')} B.`),
		).toEqual(['closer-before-opener:aaaa0001']);
	});

	it('reports both closers of a duplicated pair', () => {
		expect(
			kinds(
				`${opener('aaaa0001')} A.${serializeCloser('aaaa0001')} B.${serializeCloser('aaaa0001')}`,
			),
		).toEqual(['duplicate-closer:aaaa0001', 'duplicate-closer:aaaa0001']);
	});

	it('reports a closer whose comment was copied', () => {
		expect(
			kinds(
				`${opener('aaaa0001')} A. ${opener('aaaa0001')} B.${serializeCloser('aaaa0001')}`,
			),
		).toEqual(['duplicate-opener:aaaa0001']);
	});
});

describe('planCloser', () => {
	const plan = (doc: string, from: number, to: number) =>
		planCloser(doc, from, to, []);

	it('ends right after the last selected character, past trailing whitespace', () => {
		const doc = 'Alpha beta.\n\nNext.';
		expect(plan(doc, 0, 13)).toEqual({ kind: 'range', at: 11 });
	});

	it('a whitespace-only selection gives no range', () => {
		expect(plan('a   b', 1, 4)).toEqual({ kind: 'none' });
	});

	it('steps past an existing marker the selection ends inside', () => {
		const doc = `Text ${opener('aaaa0001')} more`;
		const m = only(doc).marker;
		expect(planCloser(doc, 0, m.start + 3, [m])).toEqual({
			kind: 'range',
			at: m.end,
		});
	});

	it('refuses an end inside a fenced code block', () => {
		const doc = 'Intro.\n\n```js\nconst x = 1;\n```\n\nAfter.';
		const inCode = doc.indexOf('x = 1') + 1;
		expect(plan(doc, 0, inCode)).toEqual({
			kind: 'refused',
			reason: CLOSER_REFUSED_MESSAGE,
		});
	});

	it('allows a range that contains a whole code block', () => {
		const doc = 'Intro.\n\n```js\nconst x = 1;\n```\n\nAfter.';
		expect(plan(doc, 0, doc.length)).toEqual({
			kind: 'range',
			at: doc.length,
		});
	});

	it('a tilde fence is a fence; a longer closing run still closes it', () => {
		const doc = '~~~\ncode\n~~~~\nprose';
		expect(plan(doc, 0, 6).kind).toBe('refused');
		expect(plan(doc, doc.indexOf('prose'), doc.length).kind).toBe('range');
	});

	it('refuses an end inside inline code, allows one right after it', () => {
		const doc = 'Use `npm run build` here.';
		expect(plan(doc, 0, doc.indexOf('run')).kind).toBe('refused');
		expect(plan(doc, 0, doc.indexOf(' here')).kind).toBe('range');
	});

	it('an unmatched backtick is literal, not code', () => {
		const doc = 'A lone ` tick and more text.';
		expect(plan(doc, 0, doc.length - 2).kind).toBe('range');
	});

	it('refuses an end inside an indented code block', () => {
		const doc = 'Intro.\n\n    code here\n\nAfter.';
		expect(plan(doc, 0, doc.indexOf('here') + 4).kind).toBe('refused');
	});

	it('an indented continuation line of a paragraph is prose, not code', () => {
		const doc = 'A paragraph line\n    that continues indented.';
		expect(plan(doc, 0, doc.length).kind).toBe('range');
	});

	it('refuses an end inside a fence within a blockquote', () => {
		const doc = 'Quote:\n\n> ```\n> code in a quote\n> ```\n\nAfter.';
		expect(plan(doc, 0, doc.indexOf('in a quote')).kind).toBe('refused');
		expect(plan(doc, 0, doc.length).kind).toBe('range');
	});

	it('refuses an end inside inline code that crosses a line break', () => {
		const doc = 'Run `npm run\nbuild` now.';
		expect(plan(doc, 0, doc.indexOf('build') + 2).kind).toBe('refused');
		expect(plan(doc, 0, doc.indexOf(' now')).kind).toBe('range');
	});

	it('inline code does not reach across a blank line', () => {
		const doc = 'One ` tick.\n\nTwo ` tick.';
		expect(plan(doc, 0, doc.indexOf('Two')).kind).toBe('range');
	});

	it('refuses an end inside the note properties', () => {
		const doc = '---\ntitle: x\n---\nBody.';
		expect(plan(doc, 4, 9).kind).toBe('refused');
		expect(plan(doc, doc.indexOf('Body'), doc.length).kind).toBe('range');
	});

	it('a later --- line is a rule, not properties', () => {
		const doc = 'Text.\n---\nmore\n---\nend';
		expect(plan(doc, 0, 12).kind).toBe('range');
	});
});
