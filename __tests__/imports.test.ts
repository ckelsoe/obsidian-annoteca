import {
	convertNativeComments,
	convertGenericHtmlComments,
	convertAllComments,
} from '../imports';
import { parseAll } from '../parser';

describe('convertNativeComments', () => {
	it('converts single-line %%comments%% to annoteca markers', () => {
		const r = convertNativeComments(
			'Prose %%fix this%% prose.',
			'uncategorized',
		);
		expect(r.converted).toBe(1);
		expect(r.updated).toBe(
			'Prose <!-- annoteca/uncategorized: fix this --> prose.',
		);
	});

	it('preserves prose between converted comments', () => {
		const r = convertNativeComments('a %%x%% b %%y%% c', 'uncategorized');
		expect(r.converted).toBe(2);
		expect(r.updated).toBe(
			'a <!-- annoteca/uncategorized: x --> b <!-- annoteca/uncategorized: y --> c',
		);
	});

	it('collapses multi-line content into a single line', () => {
		const r = convertNativeComments(
			'p %%line one\nline two%% p',
			'uncategorized',
		);
		expect(r.updated).toContain('line one line two');
	});
});

describe('convertGenericHtmlComments', () => {
	it('converts plain HTML comments', () => {
		const r = convertGenericHtmlComments(
			'Prose <!-- todo: rework --> end.',
			'uncategorized',
		);
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/uncategorized: todo: rework');
	});

	it('does not touch existing annoteca markers', () => {
		const text = `<!-- annoteca/tone: keep this --> and <!-- todo: convert this -->`;
		const r = convertGenericHtmlComments(text, 'uncategorized');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/tone: keep this');
		expect(r.updated).toContain(
			'annoteca/uncategorized: todo: convert this',
		);
	});
});

describe('convertAllComments', () => {
	it('handles both native and HTML formats in one pass', () => {
		const text = `a %%x%% b <!-- y --> c`;
		const r = convertAllComments(text, 'all', 'uncategorized');
		expect(r.converted).toBe(2);
		expect(r.updated).toContain('annoteca/uncategorized: x');
		expect(r.updated).toContain('annoteca/uncategorized: y');
	});
});

// A `%%...%%` native comment can legitimately contain `-->`, because only `%%`
// closes it. Interpolating that straight into an HTML comment ended the marker
// early and spilled the remainder into the document as visible text.
describe('imports: text containing the marker terminator', () => {
	it('escapes `-->` from a native comment so the marker survives', () => {
		const { updated, converted } = convertNativeComments(
			'Prose %%an arrow --> here%% more.',
			'note',
		);
		expect(converted).toBe(1);
		expect(updated).toBe(
			'Prose <!-- annoteca/note: an arrow --\\> here --> more.',
		);
		const parsed = parseAll(updated);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.body).toBe('an arrow --> here');
	});

	it('leaves the surrounding prose intact', () => {
		const { updated } = convertNativeComments(
			'Before %%a --> b%% after.',
			'note',
		);
		expect(updated.startsWith('Before ')).toBe(true);
		expect(updated.endsWith(' after.')).toBe(true);
	});

	it('produces the same output as before for text without the sequence', () => {
		const { updated } = convertNativeComments(
			'Prose %%plain note%% end.',
			'note',
		);
		expect(updated).toBe('Prose <!-- annoteca/note: plain note --> end.');
	});
});
