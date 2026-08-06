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

// A multi-line marker can END mid-line, with ordinary prose after its `-->`.
// The line starts inside the marker, so the line-at-a-time walk used to consume
// all of it and nothing scanned the tail: a code span sitting against the
// terminator went unprotected, and bulk convert rewrote the sample inside it.
describe('the prose after a multi-line marker terminator, same line', () => {
	const MULTILINE_OPEN = [
		'Intro prose.',
		'<!-- annoteca/note: heading line',
		'body line',
	];

	it('protects a code span in the tail', () => {
		const doc = [
			...MULTILINE_OPEN,
			'--> and `%%sample%%` sits in a span.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('still converts a bare native comment in the tail', () => {
		const doc = [...MULTILINE_OPEN, '--> tail %%real%% prose.'].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: real');
	});

	it('pairs a span from the tail across the line break, like any run', () => {
		const doc = [
			...MULTILINE_OPEN,
			'--> tail with `a span',
			'that closes %%here%% now`.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('does not carry a tail run out of an open fence', () => {
		// The marker ends mid-line INSIDE a fenced block. The tail is fence
		// content, protected by the fence itself when it closes; a run seeded
		// there would outlive the fence (nothing in the fence branch flushes
		// it) and pair its stray backtick with one in the prose below, falsely
		// protecting a real comment.
		const doc = [
			'```',
			'fence content',
			'<!-- annoteca/note: heading',
			'--> tail with ` stray backtick',
			'```',
			'Prose with %%real%% and ` another stray.',
		].join('\n');
		const r = convertAllComments(doc, 'all', 'note');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/note: real');
	});
});

// M4: code blocks whose CONTENT sits four or more columns in. Both mechanisms
// were executed against marked@12 as a CommonMark oracle before the fix: 55 of
// 263 generated container shapes had a sample rewritten and counted as a
// success, and 0 do now, with no shape moving the other way.
describe('protectedRanges: indented code and nested fences', () => {
	it('leaves a native comment inside an indented code block alone', () => {
		const doc =
			'How to write a comment:\n\n    Some prose. %%a native comment%%\n\nThat is all.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('leaves an HTML comment inside an indented code block alone', () => {
		const doc = 'Example:\n\n    <!-- an html comment -->\n\nEnd.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('measures a tab as four columns, so a tab-indented block is code', () => {
		const doc = 'How to:\n\n\tSome prose. %%a native comment%%\n\nEnd.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('keeps protecting an indented block across its blank lines', () => {
		const doc =
			'Example:\n\n    line one\n\n    %%still the same code block%%\n\nEnd.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('protects an indented block that opens the file', () => {
		const doc = '    Some prose. %%a native comment%%\n\nThat is all.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('recognises a fence nested in a list item at four columns', () => {
		const doc =
			'- Step one, write a comment:\n\n    ```markdown\n    Some prose. %%a native comment%%\n    ```\n\n- Step two.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('recognises a fence under a wide ordered marker with no blank line', () => {
		const doc =
			'10. Step one:\n    ```markdown\n    Some prose. %%a native comment%%\n    ```\n11. Step two.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	// Tilde fences, deliberately. A nested BACKTICK fence is protected even with
	// the indent bug present, because the code-span scanner pairs the opener's
	// ``` run with the closer's and calls everything between them a span. That
	// accident masks the fence rule: mutating the allowance back to an absolute
	// three columns left every backtick-fence test in this file green. A tilde
	// fence has no backticks, so it isolates the rule under test.
	it('recognises a tilde fence nested in a list item at four columns', () => {
		const doc =
			'- Step one:\n\n    ~~~\n    %%a native comment%%\n    ~~~\n\n- Step two.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('recognises a tilde fence under a wide marker with no blank line', () => {
		const doc =
			'10. Step one:\n    ~~~\n    %%a native comment%%\n    ~~~\n11. Step two.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	it('protects a task item whose sample sits past its content indent', () => {
		const doc =
			'- [ ] Step one:\n\n      ```markdown\n      %%a native comment%%\n      ```\n';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	// The other direction. The indent rule is RELATIVE, so inside an item whose
	// content starts at column 2 a line at four columns is ordinary paragraph
	// text. An absolute four-column rule would protect this and bulk convert
	// would silently skip a real comment.
	it('still converts a comment in an indented list continuation paragraph', () => {
		const doc =
			'- item\n\n    A continuation paragraph %%with a comment%%.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/uncategorized: with a comment');
	});

	it('treats six columns inside that same item as code', () => {
		const doc = '- item\n\n      A code block %%sample%% inside the item.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	// Five or more spaces after the marker is CommonMark's indented-code case:
	// content starts one column past the marker, it does NOT start where the
	// padded text does. Letting the allowance grow with the padding pushed the
	// code threshold out to eleven columns, and a real comment at four was
	// protected and silently skipped. marked@12 agrees it is prose.
	it('clamps the content indent when the marker is widely padded', () => {
		const doc =
			'1.     padded item\n\n    %%a real comment%% at four columns.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/uncategorized: a real comment');
	});

	it('clamps it for a bullet marker too', () => {
		const doc =
			'-      padded item\n\n    %%a real comment%% at four columns.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/uncategorized: a real comment');
	});

	// Leaving a NESTED item returns to its parent, not to the document margin.
	// Collapsing to "no list" read the parent's own four-column paragraph as
	// top-level indented code and skipped the real comment in it.
	it('restores the parent content indent after a nested item ends', () => {
		const doc = '- parent\n\n  - child\n\n  parent text\n\n    %%real%%';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/uncategorized: real');
	});

	it('still reads code inside that parent item as code', () => {
		const doc =
			'- parent\n\n  - child\n\n  parent text\n\n      %%sample%%';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	// The wide-padding clamp measures COLUMNS. `-\t\titem` is two padding
	// characters but seven columns, so a character count slipped under the clamp
	// and put the item's content at column 8, which then read an ordinary
	// four-column paragraph below it as code.
	it('clamps tab padding by column, not by character count', () => {
		const doc = '-\t\titem\n\n    %%real%%';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/uncategorized: real');
	});

	it('goes back to the absolute rule once the list is over', () => {
		const doc =
			'- item\n\nParagraph.\n\n    %%sample in real indented code%%\n';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});

	// A fence has three enders, not two. Raising the indent allowance is what
	// made the middle one reachable: before it, a fence could only be top-level,
	// where its closing line and EOF are the whole list.
	it('ends an unclosed fence with the list item that holds it', () => {
		const doc =
			'- item:\n\n    ```\n    unterminated\n\nOrdinary paragraph %%a real comment%% here.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/uncategorized: a real comment');
	});

	it('does not read a line past the allowance as a fence opener', () => {
		const doc =
			'- item:\n\n        ```\n\nOrdinary paragraph %%a real comment%% here.';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(1);
		expect(r.updated).toContain('annoteca/uncategorized: a real comment');
	});

	it('leaves a top-level unclosed fence protecting through end of file', () => {
		const doc = 'Prose.\n\n```\n%%sample%%\n';
		const r = convertAllComments(doc, 'all', 'uncategorized');
		expect(r.converted).toBe(0);
		expect(r.updated).toBe(doc);
	});
});
