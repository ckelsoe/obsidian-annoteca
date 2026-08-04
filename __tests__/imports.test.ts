import {
	convertNativeComments,
	convertGenericHtmlComments,
	convertAllComments,
} from '../imports';
import { parseAll, serialize } from '../parser';

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

// ---------------------------------------------------------------------------
// PR A item 1: the conversion mask.
//
// Every case below was executed against the shipped importer in the 2026-08-04
// review. The first one is the critical finding: it has been shipping since
// before #19 and "Import all" hits it, because the native pass runs first.
// ---------------------------------------------------------------------------

describe('imports: protected regions', () => {
	it('does not convert a %% comment inside an existing marker body', () => {
		const doc = serialize({
			id: 'nest0001',
			category: 'clarify',
			body: 'the body says %%fix me later%% about it',
		});
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		// Byte-identical: nesting a marker inside a marker made MARKER_RE stop
		// at the inner `-->`, and the rest of the outer marker became visible
		// prose in the user's note.
		expect(r.updated).toBe(doc);
		expect(parseAll(r.updated)).toHaveLength(1);
	});

	it('does not convert comment syntax inside a fenced code block', () => {
		const doc = [
			'Intro prose.',
			'',
			'```markdown',
			'Use %%like this%% for a native comment.',
			'Or <!-- like that --> for an HTML one.',
			'```',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('Use %%like this%% for a native comment.');
		expect(r.updated).toContain('Or <!-- like that --> for an HTML one.');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('does not convert comment syntax inside an inline code span', () => {
		const doc = 'Write `%%code%%` to comment, then %%do it%% here.';
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`%%code%%`');
		expect(r.updated).toContain('annoteca/note: do it');
	});

	it('respects a tilde fence', () => {
		const doc = ['~~~', 'Use %%like this%%.', '~~~', '', '%%real%%'].join(
			'\n',
		);
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('Use %%like this%%.');
	});

	it('respects a fence inside a block quote', () => {
		// Quoting documentation is exactly the case where a note holds comment
		// syntax it does not want rewritten.
		const doc = [
			'As the guide puts it:',
			'',
			'> ```',
			'> Use %%like this%% for a native comment.',
			'> ```',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain(
			'> Use %%like this%% for a native comment.',
		);
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('lets an unclosed fence protect through end of file', () => {
		const doc = [
			'prose',
			'```',
			'Use %%like this%%.',
			'and %%this%%.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('is idempotent: a second run converts nothing and changes nothing', () => {
		const doc = 'a %%x%% b %%y%% c <!-- z --> d';
		const first = convertAllComments(doc, 'all', 'note');
		expect(first.converted).toBe(3);
		const second = convertAllComments(first.updated, 'all', 'note');
		expect(second.converted).toBe(0);
		expect(second.updated).toBe(first.updated);
	});
});
