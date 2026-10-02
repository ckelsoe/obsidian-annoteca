// "Add comment for current sentence": which text the command selects.

import { sentenceAt } from '../sentence';
import { parseAll, scanClosers, serializeCloser } from '../parser';
import type { MarkerRange } from '../types';

// The sentence around the first `cursor` mark in `marked`, with the mark
// removed.
function pick(marked: string, cursor = '|'): string | undefined {
	const offset = marked.indexOf(cursor);
	const doc = marked.replace(cursor, '');
	const markers = parseAll(doc).map((c) => c.marker);
	const occupied: MarkerRange[] = [...markers, ...scanClosers(doc, markers)];
	const r = sentenceAt(doc, offset, occupied);
	return r ? doc.slice(r.from, r.to) : undefined;
}

describe('sentenceAt', () => {
	it('picks the sentence the cursor is in', () => {
		expect(pick('First one. The sec|ond one here. Third.')).toBe(
			'The second one here.',
		);
	});

	it('the first and the last sentence of a paragraph', () => {
		expect(pick('Fi|rst one. Second.')).toBe('First one.');
		expect(pick('First one. Sec|ond')).toBe('Second');
	});

	it('a cursor right after a full stop belongs to that sentence', () => {
		expect(pick('First one.| Second.')).toBe('First one.');
	});

	it('handles ! ? and an ellipsis, and keeps closing quotes', () => {
		expect(pick('Really? She said "st|op!" Then left.')).toBe(
			'She said "stop!"',
		);
		expect(pick('Wait… th|en what. Next.')).toBe('then what.');
	});

	it('does not end a sentence at an abbreviation, an initial or a decimal', () => {
		expect(pick('See e.g. the gu|ide by Dr. Smith. Next.')).toBe(
			'See e.g. the guide by Dr. Smith.',
		);
		expect(pick('By J. R. R. Tolk|ien. Next.')).toBe(
			'By J. R. R. Tolkien.',
		);
		expect(pick('It costs 3.5 do|llars. Next.')).toBe(
			'It costs 3.5 dollars.',
		);
	});

	it('spans soft line breaks but stops at a paragraph', () => {
		expect(pick('One sentence that\nwr|aps here. Two.')).toBe(
			'One sentence that\nwraps here.',
		);
		expect(pick('Para one has no stop\n\nPara t|wo.')).toBe('Para two.');
	});

	it('leaves list, task and heading markup out', () => {
		expect(pick('- [ ] Buy the m|ilk. Then go.')).toBe('Buy the milk.');
		expect(pick('## A head|ing')).toBe('A heading');
		expect(pick('> Quoted li|ne here.')).toBe('Quoted line here.');
		expect(pick('1. Numbered it|em.')).toBe('Numbered item.');
	});

	it('steps over an existing comment, and never splits one', () => {
		const marker =
			'<!-- annoteca/clarify: why. Really.\n[id=aaaa0001]\n-->';
		expect(pick(`Before. ${marker} The se|ntence. After.`)).toBe(
			'The sentence.',
		);
		// A full stop inside the marker does not end the sentence.
		expect(pick(`Start ${marker} and mo|re. After.`)).toContain(
			'and more.',
		);
		// The cursor inside a marker picks nothing.
		const doc = `Text ${marker} more.`;
		expect(pick(doc.replace('why', 'w|hy'))).toBeUndefined();
	});

	it('leaves another comment closer at the end out', () => {
		const doc = `The sent|ence.${serializeCloser('aaaa0001')} Next.`;
		expect(pick(doc)).toBe('The sentence.');
	});

	it('nothing on a blank line', () => {
		expect(pick('One.\n\n|\n\nTwo.')).toBeUndefined();
	});

	it('a blank line inside a comment is not a paragraph break', () => {
		const marker =
			'<!-- annoteca/clarify: para one\n\npara two\n[id=aaaa0001]\n-->';
		expect(pick(`Text ${marker} contin|ues here.`)).toBe(
			`Text ${marker} continues here.`,
		);
	});

	it('neighbouring list items are separate blocks', () => {
		expect(pick('- First item\n- Sec|ond item')).toBe('Second item');
		expect(pick('- Fi|rst item\n- Second item')).toBe('First item');
	});

	it('a heading does not run into the sentence below it', () => {
		expect(pick('## Heading\nThe sen|tence.')).toBe('The sentence.');
		expect(pick('## Head|ing\nThe sentence.')).toBe('Heading');
	});

	it('a table row is not a sentence', () => {
		// `^` marks the cursor here, since a table row is full of `|`. A
		// multi-line marker inserted into a row would end the table.
		expect(pick('| a | b |\n| c^ell | d |', '^')).toBeUndefined();
		expect(pick('| a | b |\nThe sen^tence below.', '^')).toBe(
			'The sentence below.',
		);
	});

	it('nothing on a single blank line between paragraphs', () => {
		expect(pick('One.\n|\nTwo.')).toBeUndefined();
	});
});
