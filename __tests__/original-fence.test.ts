// The `annoteca-original` fence finder, held to the pattern it replaced. That
// pattern backtracked over the rest of the body for every unclosed opener.

import { findOriginalFences } from '../parser';

const OLD_RE = /^(`{3,})annoteca-original[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;

function old(inner: string): { start: number; end: number; content: string }[] {
	return [...inner.matchAll(OLD_RE)].map((m) => ({
		start: m.index,
		end: m.index + m[0].length,
		content: m[2] ?? '',
	}));
}

// Deterministic, so a failure reproduces.
function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2147483648;
		return s / 2147483648;
	};
}

const PIECES = [
	'```',
	'````',
	'`',
	'annoteca-original',
	'\n',
	'\r\n',
	'\r',
	' ',
	' ',
	'\t',
	'x',
	'text',
	'```annoteca-original\n',
	'\n```\n',
	'\n````\n',
];

describe('findOriginalFences', () => {
	it('reads every generated body the way the old pattern did', () => {
		const next = rng(7);
		for (let n = 0; n < 20000; n++) {
			let inner = '';
			const len = Math.floor(next() * 14);
			for (let i = 0; i < len; i++)
				inner += PIECES[Math.floor(next() * PIECES.length)] ?? '';
			expect(findOriginalFences(inner)).toEqual(old(inner));
		}
	});

	it('reads a real serialized fence', () => {
		const inner =
			'body\n````annoteca-original\nhas ``` inside\r\nok\n````  \n[id=aaaaaaaa]';
		expect(findOriginalFences(inner)).toEqual(old(inner));
		expect(findOriginalFences(inner)[0]?.content).toBe(
			'has ``` inside\r\nok',
		);
	});

	it('stays linear over many unclosed openers', () => {
		// The old pattern searched the rest of the body for each opener's
		// closer: about 280 ms at 4,000 openers, growing with the square, so
		// many seconds here.
		const inner = '```annoteca-original\nx\n'.repeat(40000);
		const t0 = performance.now();
		expect(findOriginalFences(inner)).toEqual([]);
		expect(performance.now() - t0).toBeLessThan(2000);
	});
});
