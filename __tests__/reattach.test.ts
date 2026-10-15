// Anchoring hardening, part C: finding a comment's quoted text again.

import { findPassage } from '../reattach';

const slice = (s: string, p: { start: number; end: number } | undefined) =>
	p === undefined ? undefined : s.slice(p.start, p.end);

describe('findPassage', () => {
	it('finds the quote exactly, nearest the old position', () => {
		const doc = 'alpha beta. Later: alpha beta again.';
		expect(findPassage(doc, 'alpha beta', 0)).toEqual({
			start: 0,
			end: 10,
		});
		expect(findPassage(doc, 'alpha beta', 30)?.start).toBe(19);
	});

	it('tolerates different spacing, then different case', () => {
		const doc = 'The   quick\nbrown fox.';
		expect(slice(doc, findPassage(doc, 'quick brown', 0))).toBe(
			'quick\nbrown',
		);
		expect(slice(doc, findPassage(doc, 'THE QUICK', 0))).toBe(
			'The   quick',
		);
	});

	it('matches a truncated head…tail quote', () => {
		const doc = 'Start of a long passage that ends right here. After.';
		expect(slice(doc, findPassage(doc, 'Start of a…right here', 0))).toBe(
			'Start of a long passage that ends right here',
		);
	});

	it('ignores matches inside markers and properties', () => {
		const doc =
			'---\ntitle: hello world\n---\n<!-- annoteca/tone: hello world\n[id=aaaa1111]\n--> text with hello world.';
		const found = findPassage(doc, 'hello world', 0);
		expect(found?.start).toBe(doc.lastIndexOf('hello world'));
	});

	it('returns undefined when the text is gone or there is no quote', () => {
		expect(findPassage('nothing here', 'missing words', 0)).toBeUndefined();
		expect(findPassage('text', undefined, 0)).toBeUndefined();
	});
});
