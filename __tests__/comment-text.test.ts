import { commentAsMarkdown, commentsAsMarkdown } from '../comment-text';
import { endsTextSelection } from '../ui-helpers';
import type { Comment } from '../types';

const base = (over: Partial<Comment> = {}): Comment => ({
	id: 'dyj012h5',
	category: 'clarify',
	body: 'test comment',
	date: '2026-10-17T12:46:31',
	author: 'ed',
	anchor: undefined,
	replies: [],
	addressed: undefined,
	resolution: undefined,
	unknownLines: [],
	marker: { start: 0, end: 10 },
	source: undefined,
	...over,
});

describe('commentAsMarkdown', () => {
	it('heads the comment with category, author and time, then the body', () => {
		expect(commentAsMarkdown(base(), 'Clarify')).toBe(
			'**Clarify** · ed · 2026-10-17 12:46:31\n\ntest comment',
		);
	});

	it('leaves out an author or date the comment does not have', () => {
		expect(
			commentAsMarkdown(
				base({ author: undefined, date: undefined }),
				'Clarify',
			),
		).toBe('**Clarify**\n\ntest comment');
	});

	it('quotes the commented text, every line, and marks a truncated capture', () => {
		const c = base({ anchor: { text: 'one\n\ntwo', truncated: true } });
		expect(commentAsMarkdown(c, 'Clarify')).toBe(
			'**Clarify** · ed · 2026-10-17 12:46:31\n\n> one\n>\n> two…\n\ntest comment',
		);
	});

	it('keeps every reply, oldest first, with a multi-line body intact', () => {
		const c = base({
			replies: [
				{
					author: 'kilo',
					date: '2026-10-17T12:47:22',
					body: '### What I did\n\n- Parsed the marker',
				},
				{ author: 'ed', date: '2026-10-17T12:50:00', body: 'thanks' },
			],
		});
		expect(commentAsMarkdown(c, 'Clarify')).toBe(
			[
				'**Clarify** · ed · 2026-10-17 12:46:31',
				'test comment',
				'**kilo** · 2026-10-17 12:47:22',
				'### What I did\n\n- Parsed the marker',
				'**ed** · 2026-10-17 12:50:00',
				'thanks',
			].join('\n\n'),
		);
	});

	it('includes the addressed note and the original text it replaced', () => {
		const c = base({
			addressed: {
				author: 'kilo',
				date: '2026-10-17T13:00:00',
				note: 'Tightened it.',
				original: 'The old\nsentence.',
			},
		});
		expect(commentAsMarkdown(c, 'Clarify')).toBe(
			[
				'**Clarify** · ed · 2026-10-17 12:46:31',
				'test comment',
				'*Addressed 2026-10-17 13:00:00 by kilo*',
				'Tightened it.',
				'Original text:\n\n> The old\n> sentence.',
			].join('\n\n'),
		);
	});

	it('includes the resolution, and skips an empty note', () => {
		const c = base({
			resolution: { author: 'ed', date: '2026-10-18', note: '' },
		});
		expect(commentAsMarkdown(c, 'Clarify')).toBe(
			'**Clarify** · ed · 2026-10-17 12:46:31\n\ntest comment\n\n*Resolved 2026-10-18 by ed*',
		);
	});
});

describe('commentsAsMarkdown', () => {
	it('heads each note and separates its comments with a rule', () => {
		const out = commentsAsMarkdown(
			[
				{
					path: 'a.md',
					comments: [base(), base({ category: 'tone', body: 'two' })],
				},
				{ path: 'empty.md', comments: [] },
				{ path: 'b.md', comments: [base({ body: 'three' })] },
			],
			(id) => (id === 'tone' ? 'Tone' : 'Clarify'),
		);
		expect(out).toBe(
			[
				'## a.md',
				'**Clarify** · ed · 2026-10-17 12:46:31\n\ntest comment',
				'---',
				'**Tone** · ed · 2026-10-17 12:46:31\n\ntwo',
				'## b.md',
				'**Clarify** · ed · 2026-10-17 12:46:31\n\nthree',
			].join('\n\n'),
		);
	});
});

describe('endsTextSelection', () => {
	// Just the members the check reads. A Node is any object here: contains
	// is the fake's own identity test.
	const inside = {};
	const outside = {};
	const el = (selection: {
		isCollapsed: boolean;
		anchorNode: object;
		focusNode: object;
	}): HTMLElement =>
		({
			win: { getSelection: () => selection },
			contains: (n: object) => n === inside,
		}) as unknown as HTMLElement;

	it('is false for a plain click (collapsed selection)', () => {
		expect(
			endsTextSelection(
				el({
					isCollapsed: true,
					anchorNode: inside,
					focusNode: inside,
				}),
			),
		).toBe(false);
	});

	it('is true when a drag ends inside, even if it started outside', () => {
		expect(
			endsTextSelection(
				el({
					isCollapsed: false,
					anchorNode: outside,
					focusNode: inside,
				}),
			),
		).toBe(true);
	});

	it('is false for a selection somewhere else entirely', () => {
		expect(
			endsTextSelection(
				el({
					isCollapsed: false,
					anchorNode: outside,
					focusNode: outside,
				}),
			),
		).toBe(false);
	});
});
