// F-261: mapping text selected in reading view back to its source range.

import {
	countMatches,
	locateInSource,
	normalizeSelection,
	visibleText,
} from '../reading-selection';

const slice = (src: string, r: { start: number; end: number } | undefined) =>
	r === undefined ? undefined : src.slice(r.start, r.end);

describe('visibleText', () => {
	it('drops emphasis, link targets and wikilink brackets', () => {
		expect(
			visibleText(
				'Some **bold** and _em_ text, a [link](http://x.y) and [[Page|alias]] or [[Other]].',
			).text,
		).toBe('Some bold and em text, a link and alias or Other.');
	});

	it('hides Annoteca markers and closers, as reading view does', () => {
		const src =
			'Before <!-- annoteca/clarify: what?\n[id=aaaa1111]\n--> the passage<!-- /annoteca aaaa1111 --> after.';
		expect(visibleText(src).text).toBe('Before the passage after.');
	});

	it('drops heading, quote, list and task prefixes', () => {
		expect(visibleText('## Title').text).toBe('Title');
		expect(visibleText('> quoted line').text).toBe('quoted line');
		expect(visibleText('- [ ] task one\n- item two').text).toBe(
			'task one item two',
		);
		expect(visibleText('12. numbered').text).toBe('numbered');
	});

	it('keeps an underscore inside a word and single tildes', () => {
		expect(visibleText('use snake_case and ~5 ==hi==').text).toBe(
			'use snake_case and ~5 hi',
		);
	});

	it('collapses line breaks and whitespace runs to one space', () => {
		expect(visibleText('one\ntwo   three\n').text).toBe('one two three');
	});
});

describe('locateInSource', () => {
	it('finds plain text exactly', () => {
		const src = 'The quick brown fox.';
		expect(slice(src, locateInSource(src, 'quick brown', 0))).toBe(
			'quick brown',
		);
	});

	it('maps a selection across formatting back to the source span', () => {
		const src = 'A **very bold** claim here.';
		expect(slice(src, locateInSource(src, 'very bold claim', 0))).toBe(
			'very bold** claim',
		);
	});

	it('maps a link and an aliased wikilink by their shown text', () => {
		const src = 'See [the docs](https://x.y/z) and [[Target|this page]].';
		expect(slice(src, locateInSource(src, 'the docs', 0))).toBe('the docs');
		expect(slice(src, locateInSource(src, 'this page', 0))).toBe(
			'this page',
		);
	});

	it('skips a marker sitting inside the selected text', () => {
		const src =
			'Start <!-- annoteca/tone: hm\n[id=aaaa1111]\n--> middle end.';
		expect(slice(src, locateInSource(src, 'Start middle', 0))).toBe(
			'Start <!-- annoteca/tone: hm\n[id=aaaa1111]\n--> middle',
		);
	});

	it('picks the given occurrence of repeated text', () => {
		const src = 'the cat and the cat and the cat';
		const second = locateInSource(src, 'the cat', 1);
		expect(second).toEqual({ start: 12, end: 19 });
		expect(locateInSource(src, 'the cat', 3)).toBeUndefined();
	});

	it('matches a selection that spans a line break', () => {
		const src = 'line one\nline two';
		expect(slice(src, locateInSource(src, 'one\nline', 0))).toBe(
			'one\nline',
		);
	});

	it('returns undefined for text that is not there, or empty', () => {
		expect(locateInSource('abc', 'xyz', 0)).toBeUndefined();
		expect(locateInSource('abc', '   ', 0)).toBeUndefined();
	});
});

describe('selection helpers', () => {
	it('normalizes whitespace in a selection', () => {
		expect(normalizeSelection('  a\n\tb  ')).toBe('a b');
	});

	it('counts non-overlapping matches before the selection', () => {
		expect(countMatches('aaaa', 'aa')).toBe(2);
		expect(countMatches('the cat and the ', 'the cat')).toBe(1);
		expect(countMatches('x', '')).toBe(0);
	});
});
