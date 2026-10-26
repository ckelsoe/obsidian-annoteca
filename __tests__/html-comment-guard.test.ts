// Comments and other HTML comments.
//
// A reader put a Clarify comment on one word inside a diagram note
// (`<!-- diagram: ... | shows: ..., Indio, ... | status: final -->`). HTML
// comments do not nest, so the marker's `-->` ended the diagram note early: the
// rest of it showed in the note as text, and a script that builds an index from
// those notes copied half the marker into its table. Nothing refused the write
// and nothing reported it afterwards, because the marker itself parses.
//
// The same session turned up two more: an assistant copied a citation
// `<!-- c:09-82 -->` unescaped into a comment's original-text fence, which ended
// the marker at the citation's `-->`; and the diagnostics report quoted the
// markers it found, so the next run reported its own quotes. All four are
// pinned here.

import {
	forbiddenRanges,
	enclosingForbidden,
	insideForbidden,
	passageBlocked,
} from '../forbidden';
import { htmlCommentRanges, planCloser } from '../range-placement';
import { markerProblems, markersInsideHtmlComments } from '../html-comments';
import {
	isReportNote,
	REPORT_NOTE_PREFIX,
	reportJson,
	validateMarkers,
} from '../diagnostics';
import {
	hasRepairableDamage,
	hasRepairableQuote,
	repairComments,
	repairQuotedOriginals,
} from '../quote-repair';
import { findMalformedMarkers, parseAll } from '../parser';

const DIAGRAM =
	'<!-- diagram: D01-1 | type: sequence | shows: AMS360, ImageRight, Indio, producer | status: final -->';

describe('htmlCommentRanges', () => {
	it('finds an HTML comment that is not Annoteca’s', () => {
		const note = `Intro.\n\n${DIAGRAM}\n\nMore.`;
		const at = note.indexOf('<!-- diagram');
		expect(htmlCommentRanges(note)).toEqual([
			{ start: at, end: at + DIAGRAM.length },
		]);
	});

	it('leaves out Annoteca’s own markers, closers and store', () => {
		const note = [
			'Prose <!-- annoteca/clarify: [id=aaaaaaaa] -->word<!-- /annoteca aaaaaaaa --> here.',
			'',
			'<!-- annoteca:store',
			'{"v":1,"id":"aaaaaaaa","category":"clarify","body":"b"}',
			'-->',
		].join('\n');
		expect(htmlCommentRanges(note)).toEqual([]);
	});

	it('does not read a quote inside an Annoteca marker as an HTML comment', () => {
		// An older marker could hold an unescaped quote; it is the marker's.
		const note = 'A <!-- annoteca/note: quotes <!-- x --> B';
		expect(htmlCommentRanges(note)).toEqual([]);
	});

	it('skips escaped openers, code, the properties and empty comments', () => {
		const note = [
			'---',
			'note: <!-- in yaml -->',
			'---',
			'Escaped \\<!-- not a comment --> here.',
			'Inline `<!-- code -->` here.',
			'```',
			'<!-- fenced -->',
			'```',
			'Empty <!--> and <!---> here.',
		].join('\n');
		expect(htmlCommentRanges(note)).toEqual([]);
	});

	it('does not claim the rest of the note for an opener with no `-->`', () => {
		expect(htmlCommentRanges('A stray <!-- in prose.')).toEqual([]);
	});
});

describe('a new comment inside another HTML comment', () => {
	const note = `Intro.\n\n${DIAGRAM}\n\nMore.`;
	const indio = note.indexOf('Indio');

	it('is refused inside it and allowed at either edge', () => {
		expect(insideForbidden(note, indio)).toBe(true);
		expect(insideForbidden(note, note.indexOf('<!-- diagram'))).toBe(false);
		expect(insideForbidden(note, note.indexOf('-->') + 3)).toBe(false);
	});

	it('is not refused when the caller works on HTML comments itself', () => {
		expect(
			enclosingForbidden(note, indio, { htmlComments: false }),
		).toBeUndefined();
		expect(forbiddenRanges(note, { htmlComments: false })).toEqual([]);
	});

	it('gets its range end moved past the HTML comment', () => {
		// The selection starts before the diagram note and ends inside it.
		const from = note.indexOf('Intro');
		const plan = planCloser(note, from, indio, []);
		expect(plan).toEqual({
			kind: 'range',
			at: note.indexOf('-->') + 3,
		});
	});
});

describe('a comment already inside another HTML comment', () => {
	// The note as it was found: the marker ended the diagram note, and its
	// closer and the rest of the note show as text.
	const damaged =
		'<!-- diagram: D01-1 | shows: ImageRight, <!-- annoteca/clarify: [id=tqnd4ea5] --> Indio<!-- /annoteca tqnd4ea5 -->, producer | status: final -->';

	it('is reported, though the marker itself parses', () => {
		expect(findMalformedMarkers(damaged)).toEqual([]);
		const found = markersInsideHtmlComments(damaged);
		expect(found).toHaveLength(1);
		expect(found[0]?.start).toBe(damaged.indexOf('<!-- annoteca/clarify'));
		expect(found[0]?.kind).toBe('malformed');
		expect(found[0]?.reason).toContain('inside another HTML comment');
	});

	it('is in what Validate lists and the index keeps', () => {
		expect(validateMarkers(damaged, 'n.md')).toHaveLength(1);
		expect(markerProblems(damaged)).toHaveLength(1);
	});

	it('is not reported once moved out', () => {
		const fixed =
			'<!-- diagram: D01-1 | shows: ImageRight, Indio, producer | status: final -->\n\n<!-- annoteca/clarify: [id=tqnd4ea5] -->![[d.svg]]<!-- /annoteca tqnd4ea5 -->';
		expect(markerProblems(fixed)).toEqual([]);
	});
});

describe('the diagnostics report', () => {
	const finding = {
		start: 0,
		excerpt: '<!-- annoteca/decision-needed: body',
		reason: 'An unescaped `<!--`, closed by `-->`.',
		path: 'a.md',
	};

	it('writes no comment syntax, and still parses to the same values', () => {
		const json = reportJson([finding]);
		expect(json).not.toContain('<!--');
		expect(json).not.toContain('-->');
		expect(JSON.parse(json)).toEqual([finding]);
	});

	it('is not reported by the next validation run', () => {
		const note = [
			'# Malformed markers',
			'```json',
			reportJson([finding]),
			'```',
		].join('\n');
		expect(validateMarkers(note, 'r.md')).toEqual([]);
		expect(parseAll(note)).toEqual([]);
	});

	it('is recognised by name at the top of the vault only', () => {
		expect(isReportNote(`${REPORT_NOTE_PREFIX}Malformed markers.md`)).toBe(
			true,
		);
		expect(isReportNote(`notes/${REPORT_NOTE_PREFIX}x.md`)).toBe(false);
		expect(isReportNote('Malformed markers.md')).toBe(false);
	});
});

describe('an HTML comment copied into a comment’s original text', () => {
	const ORIGINAL =
		'Before the mapping, the customer normalizes its groups: "Groups need to be native". <!-- c:09-82 --> Clean groups map to roles.';
	const head = [
		'<!-- annoteca/decision-needed: Decide which.',
		'[id=p9r4ma6e]',
		'[date=2026-10-25T18:52:14]',
		'[author=claude]',
		'[anchor=Before the mapping.]',
		'[addressed claude 2026-10-25T19:11:39]: Rewrote the paragraph.',
		'```annoteca-original',
	];
	const tail =
		'```\n--> New paragraph. <!-- c:09-82 --> Next.\n\n## Next heading\n';

	// Shape 1, as found in the vault: the quote's `-->` ended the marker.
	const unclosed = [...head, ORIGINAL, tail].join('\n');
	// Shape 2: only the quote's `-->` was escaped, so the marker closes but
	// holds an unescaped `<!--`.
	const closed = [...head, ORIGINAL.replace('-->', '--\\>'), tail].join('\n');

	it('is damage the repair finds', () => {
		expect(findMalformedMarkers(unclosed).map((f) => f.kind)).toEqual([
			'possible-merge',
		]);
		expect(hasRepairableQuote(unclosed)).toBe(true);
		expect(hasRepairableDamage(unclosed)).toBe(true);
		expect(hasRepairableQuote(closed)).toBe(true);
	});

	it.each([
		['when the quote ended the marker', unclosed],
		['when the marker still closed', closed],
	])('is escaped %s, and the original reads back verbatim', (_, note) => {
		const r = repairQuotedOriginals(note);
		expect(r.converted).toBe(1);
		expect(findMalformedMarkers(r.updated)).toEqual([]);
		const [c] = parseAll(r.updated);
		expect(c?.id).toBe('p9r4ma6e');
		expect(c?.addressed?.original).toBe(ORIGINAL);
		// The marker now ends after its fence, before the new prose.
		expect(r.updated.slice(c?.marker.end)).toBe(
			' New paragraph. <!-- c:09-82 --> Next.\n\n## Next heading\n',
		);
	});

	it('is repaired once: a second run changes nothing', () => {
		const once = repairComments(unclosed);
		expect(once.converted).toBe(1);
		const twice = repairComments(once.updated);
		expect(twice).toEqual({ updated: once.updated, converted: 0 });
		expect(hasRepairableDamage(once.updated)).toBe(false);
	});

	it('leaves a marker that only mentions an HTML comment in its body', () => {
		// Not a fence: the repair has no way to tell this from a merge, and
		// Validate already names both fixes.
		const note = 'A <!-- annoteca/note: see <!-- x --> B';
		expect(repairQuotedOriginals(note)).toEqual({
			updated: note,
			converted: 0,
		});
	});

	it('leaves an unclosed fence followed by another Annoteca comment', () => {
		const note = [
			...head,
			ORIGINAL,
			'<!-- annoteca/note: another -->',
			tail,
		].join('\n');
		expect(repairQuotedOriginals(note).converted).toBe(0);
	});
});

describe('what counts as another HTML comment, at the edges', () => {
	it('is not thrown off by a fence line inside an HTML comment', () => {
		const fence = '```';
		// The fence line inside the hidden comment is not a fence, so the
		// block below is code and the last comment is real.
		const note = `<!-- hidden\n${fence}\n-->\n\n${fence}\n<!-- in code -->\n${fence}\n\n<!-- real -->`;
		const ranges = htmlCommentRanges(note);
		expect(ranges.map((r) => note.slice(r.start, r.end))).toEqual([
			`<!-- hidden\n${fence}\n-->`,
			'<!-- real -->',
		]);
	});

	it('protects a comment after an even run of backslashes', () => {
		// `\\` is an escaped backslash in markdown; the comment is live.
		const note = 'Text \\\\<!-- real comment --> end';
		expect(insideForbidden(note, note.indexOf('comment'))).toBe(true);
		const odd = 'Text \\<!-- not a comment --> end';
		expect(insideForbidden(odd, odd.indexOf('comment'))).toBe(false);
	});

	it('protects an ordinary comment that starts with the word annoteca', () => {
		const note = '<!-- annoteca notes: revise this -->';
		expect(insideForbidden(note, note.indexOf('revise'))).toBe(true);
	});
});

describe('repairing a quote that ended the marker', () => {
	it('keeps a backslash that was already in the copied text', () => {
		const original = '<!-- citation --> Example \\<!-- literal -->';
		const note = [
			'<!-- annoteca/note: fix',
			'[id=aaaaaaaa]',
			'[date=2026-10-25T10:00:00]',
			'[author=ai]',
			'[addressed ai 2026-10-25T11:00:00]: done',
			'```annoteca-original',
			original,
			'```',
			'--> New',
		].join('\n');
		const r = repairQuotedOriginals(note);
		expect(r.converted).toBe(1);
		const [c] = parseAll(r.updated);
		expect(c?.addressed?.original).toBe(original);
	});
});

describe('code spans and HTML comments read left to right', () => {
	it('does not pair a backtick inside a comment with one after it', () => {
		const note = 'A <!-- ` --> B <!-- real --> `';
		expect(insideForbidden(note, note.indexOf('real'))).toBe(true);
	});

	it('does not read a comment inside a code span', () => {
		const note = 'A `<!-- in code -->` B';
		expect(htmlCommentRanges(note)).toEqual([]);
	});

	it('protects a comment in a list item indented four spaces', () => {
		const note = '- item\n\n    <!-- diagram: in a list item -->';
		expect(insideForbidden(note, note.indexOf('list item'))).toBe(true);
	});
});

describe('code spans, at the edges', () => {
	it('does not open a span at an escaped backtick', () => {
		const note = 'Escaped \\` <!-- real --> `';
		expect(insideForbidden(note, note.indexOf('real'))).toBe(true);
	});

	it('ends a span at a blank quote line', () => {
		const note = '> A `one\n>\n> <!-- real --> `';
		expect(insideForbidden(note, note.indexOf('real'))).toBe(true);
	});

	it('stays linear in a note full of code spans', () => {
		const note = '`x` '.repeat(40000) + '<!-- real -->';
		const t = performance.now();
		expect(htmlCommentRanges(note)).toHaveLength(1);
		expect(performance.now() - t).toBeLessThan(500);
	});
});

describe('a code span stops where its paragraph does', () => {
	it.each([
		['a fence', '~~~\n`\n~~~'],
		['a heading', '# `heading'],
		['a list item', '- `item'],
	])('at %s with no blank line before it', (_, block) => {
		const note = `An unmatched \`tick\n${block}\n<!-- real comment -->`;
		expect(insideForbidden(note, note.indexOf('real'))).toBe(true);
	});
});

it('ends a code span opened in a heading with the heading', () => {
	const note = '# A `heading\n<!-- real comment --> `';
	expect(insideForbidden(note, note.indexOf('real'))).toBe(true);
});

describe('a passage that holds another HTML comment', () => {
	const note = 'Groups map to roles. <!-- c:01-8 --> Next sentence.';
	const citation = note.indexOf('<!--');
	const after = note.indexOf('-->') + 3;

	it('may contain the whole comment', () => {
		expect(passageBlocked(note, 0, after)).toBe(false);
		expect(passageBlocked(note, citation, after)).toBe(false);
	});

	it('may not start or end inside it', () => {
		expect(passageBlocked(note, 0, citation + 6)).toBe(true);
		expect(passageBlocked(note, citation + 6, note.length)).toBe(true);
	});

	it('still may not overlap Annoteca’s own syntax', () => {
		const own = 'A <!-- annoteca/note: x --> B';
		expect(passageBlocked(own, 0, own.length)).toBe(true);
	});
});
