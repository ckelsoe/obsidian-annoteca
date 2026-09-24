import { noteText, spliceRaw, toEditorText } from '../note-text';

describe('toEditorText', () => {
	it('maps CRLF and lone CR to LF like CodeMirror', () => {
		expect(toEditorText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
		expect(toEditorText('plain\ntext')).toBe('plain\ntext');
	});
});

describe('noteText.toRaw', () => {
	it('is the identity on an LF note', () => {
		const n = noteText('ab\ncd\n');
		expect(n.text).toBe(n.raw);
		for (let i = 0; i <= n.text.length; i++) expect(n.toRaw(i)).toBe(i);
	});

	it('is the identity on a lone-CR note, which is the same length', () => {
		const n = noteText('ab\rcd\r');
		expect(n.text).toBe('ab\ncd\n');
		for (let i = 0; i <= n.text.length; i++) expect(n.toRaw(i)).toBe(i);
	});

	it('maps every line boundary of a CRLF note', () => {
		const n = noteText('ab\r\ncd\r\nef');
		expect(n.text).toBe('ab\ncd\nef');
		// Before the break, at the break, after it, and the end of the file.
		expect(n.toRaw(0)).toBe(0);
		expect(n.toRaw(2)).toBe(2); // the \n in text is the \r in raw
		expect(n.toRaw(3)).toBe(4); // after the pair
		expect(n.toRaw(5)).toBe(6);
		expect(n.toRaw(6)).toBe(8);
		expect(n.toRaw(n.text.length)).toBe(n.raw.length);
	});

	it('never lands between the \\r and \\n of a pair', () => {
		const n = noteText('x\r\n\r\ny\r\n');
		for (let i = 0; i <= n.text.length; i++) {
			const r = n.toRaw(i);
			expect(
				n.raw.charAt(r - 1) === '\r' && n.raw.charAt(r) === '\n',
			).toBe(false);
		}
	});

	it('handles mixed endings', () => {
		const n = noteText('a\r\nb\rc\nd\r\n');
		expect(n.text).toBe('a\nb\nc\nd\n');
		expect(n.toRaw(2)).toBe(3); // start of b
		expect(n.toRaw(4)).toBe(5); // start of c
		expect(n.toRaw(6)).toBe(7); // start of d
		expect(n.toRaw(8)).toBe(10); // end of file
	});
});

describe('noteText.endingAt', () => {
	it('reports the ending of the line the offset sits on', () => {
		const n = noteText('a\r\nb\rc\nd');
		expect(n.endingAt(0)).toBe('\r\n');
		expect(n.endingAt(1)).toBe('\r\n'); // at the break itself
		expect(n.endingAt(2)).toBe('\r');
		expect(n.endingAt(4)).toBe('\n');
	});

	it('uses the last break for a final line with none', () => {
		expect(noteText('a\r\nb').endingAt(2)).toBe('\r\n');
		expect(noteText('a\rb').endingAt(3)).toBe('\r');
		expect(noteText('a\nb').endingAt(3)).toBe('\n');
	});

	it('defaults to \\n for a note with no line breaks', () => {
		expect(noteText('').endingAt(0)).toBe('\n');
		expect(noteText('one line').endingAt(3)).toBe('\n');
	});
});

describe('spliceRaw', () => {
	it('writes inserted line breaks in the local ending and keeps other bytes', () => {
		const n = noteText('one\r\ntwo\nthree\r\n');
		const out = spliceRaw(n, [
			{ from: 0, to: 3, insert: 'A\nB' },
			{ from: 4, to: 7, insert: 'C\nD' },
		]);
		expect(out).toBe('A\r\nB\r\nC\nD\nthree\r\n');
	});

	it('removes a whole CRLF pair when the range covers the editor \\n', () => {
		const n = noteText('keep\r\ndrop\r\nkeep');
		const out = spliceRaw(n, [{ from: 5, to: 10, insert: '' }]);
		expect(out).toBe('keep\r\nkeep');
	});

	it('is order-independent', () => {
		const n = noteText('a\r\nb\r\nc');
		const splices = [
			{ from: 0, to: 1, insert: 'X' },
			{ from: 4, to: 5, insert: 'Z' },
		];
		expect(spliceRaw(n, splices)).toBe(
			spliceRaw(n, [...splices].reverse()),
		);
		expect(spliceRaw(n, splices)).toBe('X\r\nb\r\nZ');
	});

	it('normalizes a stray \\r in an insert before converting', () => {
		const n = noteText('a\r\nb');
		expect(spliceRaw(n, [{ from: 1, to: 1, insert: 'x\r\ny' }])).toBe(
			'ax\r\ny\r\nb',
		);
	});
});

// Seeded, so a failure replays. Random text in a random ending style (including
// mixed), random editor ranges: the raw slice between the mapped offsets must
// read as the same editor text.
describe('noteText property', () => {
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
	const rand = mulberry32(0x11e3e3d);
	const pick = <T>(xs: readonly T[]): T => {
		const x = xs[Math.floor(rand() * xs.length)];
		if (x === undefined) throw new Error('empty pool');
		return x;
	};
	const ENDINGS = ['\n', '\r\n', '\r'] as const;
	const WORDS = ['a', 'bc', ' ', 'def', '<!--', '-->', ''];

	it('raw.slice(toRaw(a), toRaw(b)) reads as text.slice(a, b)', () => {
		for (let iter = 0; iter < 2000; iter++) {
			const style = pick(['\n', '\r\n', '\r', 'mixed'] as const);
			const lines = Math.floor(rand() * 8);
			let raw = '';
			for (let l = 0; l < lines; l++) {
				raw += pick(WORDS) + pick(WORDS);
				raw += style === 'mixed' ? pick(ENDINGS) : style;
			}
			if (rand() < 0.5) raw += pick(WORDS);
			const n = noteText(raw);
			const a = Math.floor(rand() * (n.text.length + 1));
			const b = a + Math.floor(rand() * (n.text.length - a + 1));
			expect(toEditorText(raw.slice(n.toRaw(a), n.toRaw(b)))).toBe(
				n.text.slice(a, b),
			);
			// And a splice round-trips through the editor view.
			const out = spliceRaw(n, [{ from: a, to: b, insert: 'X\nY' }]);
			expect(toEditorText(out)).toBe(
				`${n.text.slice(0, a)}X\nY${n.text.slice(b)}`,
			);
			// Every stored byte outside the splice is kept, whatever its ending,
			// and the insert's break is the ending of the line it starts on.
			const ending = n.endingAt(a);
			expect(out).toBe(
				`${raw.slice(0, n.toRaw(a))}X${ending}Y${raw.slice(n.toRaw(b))}`,
			);
		}
	});
});
