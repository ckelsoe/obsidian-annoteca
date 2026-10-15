// Where a new marker goes so the note still renders (see marker-placement.ts).
// Each "renders" shape here was checked in Obsidian's reading view.

import {
	gapEnd,
	headingTextEnd,
	markerRemovalSpan,
	layoutMarker,
	markerBreaksReadingView,
	planMarkerInsert,
	repairMarkerPlacement,
} from '../marker-placement';
import { parseAll } from '../parser';

const M = '<!-- annoteca/tone: x\n[id=aaaa1111]\n-->';
const LEAN = '<!-- annoteca/tone: [id=aaaa1111] -->';

// Insert a marker for the passage that starts at `needle` in `doc`.
function place(doc: string, needle: string, marker = M): string {
	const start = doc.indexOf(needle);
	const plan = planMarkerInsert(doc, start, marker.includes('\n'));
	return (
		doc.slice(0, plan.at) +
		layoutMarker(plan, marker, ' ') +
		doc.slice(plan.at)
	);
}

describe('planMarkerInsert', () => {
	it('keeps a mid-line marker inline', () => {
		expect(place('Some text here.', 'text')).toBe(`Some ${M} text here.`);
	});

	it('puts a paragraph-start marker on its own line above', () => {
		expect(place('Intro.\n\nSome text.', 'Some')).toBe(
			`Intro.\n\n${M}\nSome text.`,
		);
		expect(place('Some text.', 'Some')).toBe(`${M}\nSome text.`);
	});

	it('moves a wrapped-line marker to the end of the line before', () => {
		expect(place('First line\nsecond line.', 'second')).toBe(
			`First line ${M}\nsecond line.`,
		);
	});

	it('keeps a hard line break when appending to the line before', () => {
		expect(place('First line  \nsecond.', 'second')).toBe(
			`First line ${M}  \nsecond.`,
		);
	});

	it('does not append to a heading, fence or table line', () => {
		expect(place('## Head\nText.', 'Text')).toBe(`## Head\n${M}\nText.`);
		expect(place('```\ncode\n```\nText.', 'Text')).toBe(
			`\`\`\`\ncode\n\`\`\`\n${M}\nText.`,
		);
		expect(place('| a |\nText.', 'Text')).toBe(`| a |\n${M}\nText.`);
	});

	it('keeps a list item together: marker after the bullet, text indented', () => {
		expect(place('- one\n- two', 'two')).toBe(`- one\n- ${M}\n  two`);
		expect(place('1. two', 'two')).toBe(`1. ${M}\n   two`);
		expect(place('> - two', 'two')).toBe(`> - ${M}\n>   two`);
	});

	it('leaves a task item inline, after its box', () => {
		expect(place('- [ ] task', 'task')).toBe(`- [ ] ${M} task`);
	});

	it('keeps a quote together: marker after >, text on the next > line', () => {
		expect(place('> quoted', 'quoted')).toBe(`> ${M}\n> quoted`);
	});

	it('puts a multi-line marker on a heading above it', () => {
		expect(place('## Head word', 'word')).toBe(`${M}\n## Head word`);
	});

	it('keeps a single-line marker on a heading inline', () => {
		expect(place('## Head word', 'word', LEAN)).toBe(
			`## Head ${LEAN} word`,
		);
	});
});

describe('gapEnd', () => {
	const at = (s: string, pos: number) => gapEnd((p) => s.charAt(p), pos);

	it('skips one space, or a line break and the next line prefix', () => {
		expect(at('X text', 1)).toBe(2);
		expect(at('X\ntext', 1)).toBe(2);
		expect(at('X\n  text', 1)).toBe(4);
		expect(at('X\n> text', 1)).toBe(4);
		expect(at('X\n## Head', 1)).toBe(5);
	});

	it('skips blank lines a formatter put after a marker on its own line', () => {
		expect(at('X\n\ntext', 1)).toBe(3);
		expect(at('X\n\n  \n> text', 1)).toBe(8);
	});
});

describe('markerBreaksReadingView', () => {
	const breaks = (doc: string): boolean => {
		const [c] = parseAll(doc);
		if (!c) throw new Error('no marker');
		return markerBreaksReadingView(doc, c.marker.start, c.marker.end);
	};

	it('flags a marker that opens a block with text after it', () => {
		expect(breaks(`${M} Some text.`)).toBe(true);
		expect(breaks(`First\n${M} second.`)).toBe(true);
		expect(breaks(`- ${M} two`)).toBe(true);
		expect(breaks(`> ${M} quoted`)).toBe(true);
		expect(breaks(`${LEAN} Some text.`)).toBe(true);
	});

	it('flags a multi-line marker on a heading', () => {
		expect(breaks(`## Head ${M} word`)).toBe(true);
	});

	it('passes the shapes that render', () => {
		expect(breaks(`Some ${M} text.`)).toBe(false);
		expect(breaks(`${M}\nSome text.`)).toBe(false);
		expect(breaks(`- ${M}\n  two`)).toBe(false);
		expect(breaks(`## Head ${LEAN} word`)).toBe(false);
	});
});

describe('repairMarkerPlacement', () => {
	it('moves every breaking marker and counts them', () => {
		const doc = `${M} Para one.\n\nPara two has ${M.replace('aaaa1111', 'bbbb2222')} an inline one.\n\n- item\n- ${M.replace('aaaa1111', 'cccc3333')} two`;
		const { updated, converted } = repairMarkerPlacement(doc);
		expect(converted).toBe(2);
		expect(updated).toBe(
			`${M}\nPara one.\n\nPara two has ${M.replace('aaaa1111', 'bbbb2222')} an inline one.\n\n- item\n- ${M.replace('aaaa1111', 'cccc3333')}\n  two`,
		);
		// Every comment is still there, and nothing breaks any more.
		expect(parseAll(updated).map((c) => c.id)).toEqual([
			'aaaa1111',
			'bbbb2222',
			'cccc3333',
		]);
		expect(repairMarkerPlacement(updated).converted).toBe(0);
	});

	it('changes nothing in a note that renders', () => {
		const doc = `Fine ${M} text.`;
		expect(repairMarkerPlacement(doc)).toEqual({
			updated: doc,
			converted: 0,
		});
	});
});

describe('headingTextEnd', () => {
	it('gives the end of the heading text on a heading line, else undefined', () => {
		const doc = 'Intro.\n## Keep target tail  \nBody.';
		expect(headingTextEnd(doc, doc.indexOf('target'))).toBe(
			doc.indexOf('tail') + 4,
		);
		expect(headingTextEnd(doc, doc.indexOf('Body'))).toBeUndefined();
	});
});

describe('markerRemovalSpan', () => {
	const remove = (doc: string): string => {
		const [c] = parseAll(doc);
		if (!c) throw new Error('no marker');
		const r = markerRemovalSpan(doc, c.marker.start, c.marker.end);
		return doc.slice(0, r.from) + doc.slice(r.to);
	};

	it('takes out only what each placement added', () => {
		expect(remove(`Some ${M} text.`)).toBe('Some text.');
		expect(remove(`${M}\nSome text.`)).toBe('Some text.');
		expect(remove(`${M}\n## Heading`)).toBe('## Heading');
		expect(remove(`- ${M}\n  two`)).toBe('- two');
		expect(remove(`> ${M}\n> quoted`)).toBe('> quoted');
		expect(remove(`First line ${M}\nsecond.`)).toBe('First line\nsecond.');
	});
});
