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

	it('does not convert comment syntax inside a code span that crosses a line', () => {
		// Legal CommonMark: a code span is inline content and runs across a line
		// break inside a paragraph. The scanner used to work one line at a time,
		// so it saw two unpaired backticks rather than one span, protected
		// nothing, and rewrote the sample the note was trying to show.
		const doc = [
			'Write `%%code',
			'over two lines%%` to comment, then %%do it%% here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`%%code\nover two lines%%`');
		expect(r.updated).toContain('annoteca/note: do it');
	});

	it.each([
		['a heading', '# Heading'],
		['a list item', '- a list item'],
		['an ordered list item', '1. a list item'],
		['a block quote', '> quoted'],
		['a thematic break', '---'],
	])('does not let a code span reach across %s', (_label, divider) => {
		// Each of these interrupts a paragraph in CommonMark, so the backticks
		// either side of it are in different blocks and cannot form one span.
		// A run that reached across would mark the comment protected, and bulk
		// import would convert nothing and report it as "no comments found".
		const doc = [
			'A stray ` backtick.',
			divider,
			'%%convert me%% here.',
			'Another ` backtick.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('lets a code span cross a line starting "2." in a paragraph', () => {
		// An ordered list can only interrupt a paragraph when it starts at 1, so
		// this "2." is ordinary text and the span is real. Treating every
		// ordered marker as a boundary split the span and let import rewrite
		// the sample inside it, which is the destructive direction.
		const doc = [
			'Open `code',
			'2. %%sample%% still code`',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`code\n2. %%sample%% still code`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('ends the item above when "2." is a real list item', () => {
		// The other side of the same rule: a list is already open here, so the
		// marker starts a new item and the two backticks are in different ones.
		const doc = [
			'1. an item with a stray ` backtick',
			'2. %%convert me%% and another ` backtick',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('starts a list even when it is numbered from something other than 1', () => {
		// With no paragraph open there is nothing to interrupt, so `2.` opens a
		// list and `3.` is a second item. Requiring a 1 here merged the two into
		// one run, and their stray backticks then paired across items.
		const doc = [
			'2. an item with a stray ` backtick',
			'3. %%convert me%% and another ` backtick',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('ends the item above when a nested item is indented under it', () => {
		// A nested item is a block of its own, however far it is indented, so
		// the backticks either side of it belong to different blocks. Capping
		// the marker at three spaces of indent missed this and paired them.
		const doc = [
			'- outer item with a stray ` backtick',
			'    - %%convert me%% and another ` backtick',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('lets a code span cross two lines of one block quote', () => {
		// An Obsidian callout is a block quote, so consecutive `>` lines are one
		// block and a wrapped span inside them is real. Flushing at every quote
		// line split it and let import rewrite the sample.
		const doc = [
			'> [!note] Example',
			'> Use `%%sample',
			'> continued%%` for a comment.',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`%%sample\n> continued%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('does not pair backticks across two rows of a table', () => {
		// Each cell parses its inline content on its own, so a backtick in one
		// row cannot open a span that closes in another.
		const doc = [
			'| col |',
			'| --- |',
			'| a stray ` backtick |',
			'| %%convert me%% and another ` backtick |',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('treats a marker indented past the item content as continuation text', () => {
		// `- outer` starts its content at column 2, so a marker at column 6 is
		// four columns further in: indented code inside the item, which cannot
		// interrupt its paragraph, so the span across those lines is real.
		const doc = [
			'- outer item with `%%code',
			'      - still inside the span%%` here',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain(
			'`%%code\n      - still inside the span%%`',
		);
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('ends a generic HTML comment at its closing delimiter', () => {
		// The comment is a raw HTML block: it holds no code spans, and the
		// paragraph under it is a different block. Letting the run carry on past
		// it paired the two backticks and protected both comments, so "Import
		// all" converted none of them.
		const doc = [
			'<!-- generic with ` -->',
			'%%convert me%% and a ` backtick.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(2);
		expect(r.updated).toContain('annoteca/note: convert me');
		expect(r.updated).toContain('annoteca/note: generic with `');
	});

	it('ends a multi-line generic HTML comment at its closing delimiter', () => {
		// Both halves of the rule in one document. A backtick inside the comment
		// must not pair with one in the paragraph under it, and the paragraph
		// under it must still get its own spans protected: reading the block as
		// prose does the first, and never ending it does the second.
		const doc = [
			'<!-- generic',
			'with a stray ` inside -->',
			'Then `%%code',
			'over two lines%%` in a span, and a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(2);
		// A span across the two lines below the comment is what proves the block
		// ended: while it is open every line is scanned on its own, so a wrapped
		// span cannot form at all.
		expect(r.updated).toContain('`%%code\nover two lines%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('keeps a code span inside a generic HTML comment protected', () => {
		// The native pass converts a `%%...%%` wherever it sits, so a marker
		// written inside this comment closes it early with its own `-->` and
		// spills the remainder into the note. The span is what stops that, so
		// the comment's lines have to keep being scanned for spans.
		const doc = [
			'<!-- write it as `%%example%%` in a note',
			'and it stays put -->',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.updated).toContain('`%%example%%`');
		expect(r.updated).toContain('annoteca/note: one');
		// One marker in the result, and it is the one out in the prose. The
		// outer comment is left alone because the span inside it is protected
		// and its own range overlaps that: the same answer this importer has
		// always given for a comment whose body holds a code span, and the safe
		// one, since converting it is what would nest a marker inside it.
		expect(parseAll(r.updated)).toHaveLength(1);
		expect(r.updated).toContain('<!-- write it as `%%example%%`');
	});

	it('keeps a code span on a later line of a generic HTML comment protected', () => {
		// Same rule as above, one line down, because the opener line and the
		// lines under it are handled by different branches.
		const doc = [
			'<!-- write it as',
			'`%%example%%` in a note -->',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.updated).toContain('`%%example%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('closes a code span only on a run of the same length', () => {
		// CommonMark pairs a backtick run with the next run of EXACTLY its
		// length; a longer run in between is ordinary text. Closing on the first
		// run that is long enough cut the span short and exposed the comment
		// that was inside it.
		const doc = 'A `x``` y%%convert me%%z` here, then %%do it%% out there.';
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`x``` y%%convert me%%z`');
		expect(r.updated).toContain('annoteca/note: do it');
	});

	it('lets a marker terminator close a generic comment opened above it', () => {
		// An HTML block ends on the first line carrying `-->`, and a marker's
		// own terminator is such a line. Marker lines are consumed before the
		// in-comment state is ever consulted, so without clearing it there the
		// comment outlived the comment and every run below it was cut to one
		// line.
		const doc = [
			'<!-- an opener with no closer of its own',
			'',
			'<!-- annoteca/note: an ordinary marker',
			'[id=aaaa1111]',
			'-->',
			'',
			'Then `%%code',
			'over two lines%%` in a span, and a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		// A span across two lines is what proves the state cleared: while the
		// flag is stuck, every line is scanned on its own and a wrapped span
		// cannot form at all.
		expect(r.updated).toContain('`%%code\nover two lines%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('does not let an unclosed HTML comment swallow the rest of the file', () => {
		// A `<!--` with no closer anywhere below is a typo, not a block. Reading
		// it as one would stop protecting every code span under it.
		const doc = [
			'<!-- an opener that never closes',
			'',
			'Then `%%code',
			'over two lines%%` in a span, and a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		// A span across two lines is what proves the document is not inside a
		// comment: while it is, every line is scanned on its own.
		expect(r.updated).toContain('`%%code\nover two lines%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('does not pair a backtick in indented code with one in the prose below', () => {
		// Four spaces after a blank line opens an indented code block, so it is
		// not the first line of the paragraph under it.
		const doc = ['    stray `', '%%convert me%% and a ` backtick.'].join(
			'\n',
		);
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('keeps a deeply indented continuation line with its paragraph', () => {
		// Indentation cannot interrupt a paragraph, so this span is real and the
		// indented-code rule must not fire for it.
		const doc = [
			'A paragraph with `%%code',
			'    over two indented lines%%` in it.',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`%%code\n    over two indented lines%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('still protects a code span inside a heading or a list item', () => {
		// The block-boundary break must not cost these lines the protection the
		// per-line scanner already gave them.
		const doc = [
			'# A heading with `%%code%%` in it',
			'',
			'- a list item with `%%more code%%` in it',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`%%code%%`');
		expect(r.updated).toContain('`%%more code%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('does not pair a backtick in a heading with one in the text below it', () => {
		// A heading is the whole block: its text cannot continue onto the next
		// line, so its run holds nothing but itself.
		const doc = ['# A ` heading', '%%convert me%% and a ` backtick.'].join(
			'\n',
		);
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('lets a code span cross a line inside a list item', () => {
		// The other side of the rule: an item's paragraph DOES continue onto
		// the lines below it, so a span opened on the item line stays open.
		const doc = [
			'- an item with `%%code',
			'over two lines%%` in it',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`%%code\nover two lines%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	it('does not pair part of a backtick run with a lone backtick', () => {
		// A run with no matching run is literal text and scanning resumes after
		// it, so every span here is one a renderer also sees. Letting the opener
		// backtrack into the middle of the ``` swallowed the first span, exposed
		// `%%like this%%`, and then protected a stretch of ordinary prose.
		const doc = [
			'A ``` run, then `%%like this%%` and `<!-- like that -->`, plus',
			'inline `` `%%code%%` `` and a plain `%%real%%` after it.',
			'',
			'And a real %%one%% out here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('`%%like this%%`');
		expect(r.updated).toContain('`<!-- like that -->`');
		expect(r.updated).toContain('`` `%%code%%` ``');
		expect(r.updated).toContain('`%%real%%`');
		expect(r.updated).toContain('annoteca/note: one');
	});

	// A marker begins mid-line in the shape the plugin itself writes: the marker
	// and the prose it annotates are spliced into one line, which is what this
	// file's own fixtures look like. Such a line begins OUTSIDE the marker, so a
	// scanner that only asks whether a line STARTS inside one lets the marker's
	// body join the surrounding text. Both directions of that were reproduced
	// through the real "Import all" entry point before these landed.
	describe('an inline marker body is opaque to the code-span scanner', () => {
		const SAMPLE = 'The documented sample is `%%not a comment%%` in code.';

		it('does not rewrite text inside a genuine code span', () => {
			const doc = [
				'Review this <!-- annoteca/tone: check the ` char --> here.',
				SAMPLE,
			].join('\n');
			const r = convertNativeComments(doc, 'note');
			expect(r.converted).toBe(0);
			expect(r.updated).toContain('`%%not a comment%%`');
		});

		it('reaches the same conclusion through "Import all"', () => {
			const doc = [
				'Review this <!-- annoteca/tone: check the ` char --> here.',
				SAMPLE,
			].join('\n');
			expect(convertAllComments(doc, 'all', 'note').updated).toContain(
				'`%%not a comment%%`',
			);
		});

		it('does not silently skip a real comment either', () => {
			// The other direction: a body backtick pairing with a prose one
			// marked the comment between them protected, so import converted
			// nothing and reported it as there being nothing to convert.
			const doc = [
				'Some `unclosed tick in prose',
				'%%should convert%%',
				'More prose <!-- annoteca/tone: body has a ` tick -->',
			].join('\n');
			expect(convertNativeComments(doc, 'note').converted).toBe(1);
		});

		it('control: the same document with the marker at column 0', () => {
			const doc = [
				'<!-- annoteca/tone: check the ` char -->',
				SAMPLE,
			].join('\n');
			expect(convertNativeComments(doc, 'note').converted).toBe(0);
		});

		it('control: the same inline marker with no backtick in its body', () => {
			const doc = [
				'Review this <!-- annoteca/tone: check the char --> here.',
				SAMPLE,
			].join('\n');
			expect(convertNativeComments(doc, 'note').converted).toBe(0);
		});
	});

	it('does not let a code span reach across a marker', () => {
		// A run is a contiguous slice of the document, so a run allowed to span
		// a marker would scan the marker's own text as if it were prose and let
		// backticks either side of it pair up. The marker's interior is opaque
		// to this scanner, which is the same "what can a body CONTAIN?" answer
		// the fence rule already gives.
		const doc = [
			'Prose with a ` backtick.',
			'<!-- annoteca/note: an ordinary body',
			'[id=aaaa1111]',
			'-->',
			'Then %%convert me%% and a ` backtick.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('does not let a stray backtick pair across a blank line', () => {
		// The other half of the rule. A code span cannot cross a paragraph
		// break, so two unrelated backticks must not join up and protect
		// everything between them, which would silently import nothing.
		const doc = [
			'A stray ` backtick.',
			'',
			'%%convert me%%',
			'',
			'Another ` backtick.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
	});

	it('does not let a code span reach across a fence', () => {
		const doc = [
			'A stray ` backtick and %%convert me%%.',
			'```',
			'fenced',
			'```',
			'Another ` backtick.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: convert me');
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

	it('does not let a fence inside a marker body swallow the rest of the file', () => {
		// Marker bodies are arbitrary user text and the format stores the
		// annoteca-original block as a literal fence, so a ``` line inside a
		// marker is ordinary. Reading those as document structure let one
		// unbalanced fence line mark everything after it protected, so import
		// silently converted nothing and reported a count of zero.
		const doc = [
			serialize({
				id: 'fence001',
				category: 'note',
				body: 'this body mentions a fence\n```\nand never closes it',
			}),
			'',
			'Real prose with %%a real comment%% in it.',
			'',
			'And %%another one%% here.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(2);
		expect(r.updated).toContain('annoteca/note: a real comment');
		expect(r.updated).toContain('annoteca/note: another one');
		// The marker itself is still untouched.
		expect(r.updated).toContain(
			'annoteca/note: this body mentions a fence',
		);
		expect(parseAll(r.updated)).toHaveLength(3);
	});

	it("does not let an addressed marker's original fence leak either", () => {
		const doc = [
			serialize({
				id: 'fence002',
				category: 'note',
				body: 'body',
				addressed: {
					author: 'ai',
					date: '2026-08-01T10:00:00',
					note: 'applied',
					// The stored original holds a lone fence line of its own,
					// which serialize widens the delimiter to survive.
					original: 'old text\n```\nunbalanced',
				},
			}),
			'',
			'Prose with %%a real comment%% after it.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: a real comment');
	});

	it('keeps protecting a fence that opens outside a marker and closes after one', () => {
		const doc = [
			'```',
			'Use %%like this%%.',
			serialize({ id: 'fence003', category: 'note', body: 'inside' }),
			'Still %%in the fence%%.',
			'```',
			'',
			'Out here %%is real%%.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('Use %%like this%%.');
		expect(r.updated).toContain('Still %%in the fence%%.');
		expect(r.updated).toContain('annoteca/note: is real');
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
