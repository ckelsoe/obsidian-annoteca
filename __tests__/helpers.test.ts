import { rgbStringToHex } from '../ui-helpers';
import {
	extractIndexTerm,
	bucketCommentsByHeading,
	decideScrollAction,
	planActiveCommentDecorations,
	ACTIVE_COMMENT_CLASS,
	ACTIVE_COMMENT_MARKER_CLASS,
	resolveAnchorRange,
	authorColorFor,
	authorPickerOptions,
	shouldSubmitOnKeydown,
} from '../view-utils';
import type { AuthorStyle } from '../types';
import { computeScopeFileSet, type ScopeFile } from '../scope';
import { parseAll, serialize, buildAnchorFromSelection } from '../parser';
import type { Comment, ScopeShape } from '../types';

describe('rgbStringToHex', () => {
	it('converts standard rgb() to lower-case 6-digit hex', () => {
		expect(rgbStringToHex('rgb(255, 128, 0)')).toBe('#ff8000');
	});

	it('handles rgb() without spaces', () => {
		expect(rgbStringToHex('rgb(0,0,0)')).toBe('#000000');
	});

	it('ignores the alpha channel on rgba()', () => {
		expect(rgbStringToHex('rgba(15, 200, 100, 0.5)')).toBe('#0fc864');
	});

	it("clamps high channels to 255 and treats stray '-' as a separator", () => {
		// The regex matches \d+, so '-5' becomes '5'; '300' clamps to 'ff'.
		// Browsers never emit negative components, so this quirk is moot in
		// practice; the test pins the actual behavior.
		expect(rgbStringToHex('rgb(300, -5, 128)')).toBe('#ff0580');
	});

	it('rounds fractional channels', () => {
		expect(rgbStringToHex('rgb(127.5, 127.5, 127.5)')).toBe('#808080');
	});

	it("returns undefined on 'transparent'", () => {
		expect(rgbStringToHex('transparent')).toBeUndefined();
	});

	it('returns undefined on an empty string', () => {
		expect(rgbStringToHex('')).toBeUndefined();
	});

	it('returns undefined when fewer than three numbers parse out', () => {
		expect(rgbStringToHex('rgb(10)')).toBeUndefined();
	});
});

describe('extractIndexTerm', () => {
	it('returns the body unchanged when no em-dash is present', () => {
		expect(extractIndexTerm('Topic')).toBe('Topic');
	});

	it('preserves a term > subterm chain', () => {
		expect(extractIndexTerm('Topic > Sub')).toBe('Topic > Sub');
	});

	it('strips the post-em-dash body from a flat term', () => {
		expect(extractIndexTerm('Topic — body text')).toBe('Topic');
	});

	it('strips the post-em-dash body from a term > subterm chain', () => {
		expect(extractIndexTerm('Topic > Sub — body text')).toBe('Topic > Sub');
	});

	it("returns '(unspecified)' for empty input", () => {
		expect(extractIndexTerm('')).toBe('(unspecified)');
	});

	it("returns '(unspecified)' for whitespace-only input", () => {
		expect(extractIndexTerm('   ')).toBe('(unspecified)');
	});

	it('trims surrounding whitespace from the term', () => {
		expect(extractIndexTerm('  Topic  ')).toBe('Topic');
	});
});

describe('bucketCommentsByHeading', () => {
	const heading = (heading: string, level: number, offset: number) => ({
		heading,
		level,
		position: { start: { offset } },
	});
	const comment = (start: number, resolved = false): Comment => ({
		id: undefined,
		category: 'clarify',
		body: 'x',
		date: undefined,
		author: undefined,
		anchor: undefined,
		marker: { start, end: start + 10 },
		replies: [],
		addressed: undefined,
		resolution: resolved
			? { date: '2026-01-01', author: 'x', note: '' }
			: undefined,
	});

	it('returns an empty array when there are no headings', () => {
		expect(bucketCommentsByHeading([], [comment(50)])).toEqual([]);
	});

	it('returns zero-filled buckets when there are no comments', () => {
		expect(bucketCommentsByHeading([heading('H1', 1, 0)], [])).toEqual([
			{ open: 0, resolved: 0 },
		]);
	});

	it('does not count comments that sit before the first heading', () => {
		const result = bucketCommentsByHeading(
			[heading('H1', 1, 100)],
			[comment(50)],
		);
		expect(result).toEqual([{ open: 0, resolved: 0 }]);
	});

	it('buckets open and resolved comments into the most-recent heading', () => {
		const headings = [heading('H1', 1, 0), heading('H2', 1, 200)];
		const comments = [
			comment(50),
			comment(75, true),
			comment(250),
			comment(300),
		];
		expect(bucketCommentsByHeading(headings, comments)).toEqual([
			{ open: 1, resolved: 1 },
			{ open: 2, resolved: 0 },
		]);
	});
});

describe('shouldSubmitOnKeydown', () => {
	const key = (
		k: string,
		mods: Partial<{
			shiftKey: boolean;
			ctrlKey: boolean;
			metaKey: boolean;
		}> = {},
	) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

	describe('submit-on-Enter mode', () => {
		it('submits on plain Enter', () => {
			expect(shouldSubmitOnKeydown(key('Enter'), true)).toBe(true);
		});
		it('does not submit on Shift+Enter (newline)', () => {
			expect(
				shouldSubmitOnKeydown(key('Enter', { shiftKey: true }), true),
			).toBe(false);
		});
		it('ignores non-Enter keys', () => {
			expect(shouldSubmitOnKeydown(key('a'), true)).toBe(false);
		});
	});

	describe('modifier-Enter mode', () => {
		it('does not submit on plain Enter (newline)', () => {
			expect(shouldSubmitOnKeydown(key('Enter'), false)).toBe(false);
		});
		it('submits on Ctrl+Enter', () => {
			expect(
				shouldSubmitOnKeydown(key('Enter', { ctrlKey: true }), false),
			).toBe(true);
		});
		it('submits on Cmd+Enter', () => {
			expect(
				shouldSubmitOnKeydown(key('Enter', { metaKey: true }), false),
			).toBe(true);
		});
	});
});

describe('decideScrollAction (F-276, F-289)', () => {
	it('centers when alignment is center, regardless of visibility', () => {
		expect(decideScrollAction('center', true)).toBe('center');
		expect(decideScrollAction('center', false)).toBe('center');
	});

	it('anchors to the top when alignment is top, regardless of visibility', () => {
		expect(decideScrollAction('top', true)).toBe('top');
		expect(decideScrollAction('top', false)).toBe('top');
	});

	it('does not scroll in minimal mode when the target is already in the viewport', () => {
		expect(decideScrollAction('minimal', true)).toBe('none');
	});

	it('scrolls minimally in minimal mode when the target is off-screen', () => {
		expect(decideScrollAction('minimal', false)).toBe('minimal');
	});

	it('forces a minimal scroll even when visible, for the sync button', () => {
		expect(decideScrollAction('minimal', true, true)).toBe('minimal');
	});
});

describe('planActiveCommentDecorations (F-276)', () => {
	const mk = (start: number, end: number): Comment => ({
		id: undefined,
		category: 'clarify',
		body: 'x',
		date: undefined,
		author: undefined,
		anchor: undefined,
		marker: { start, end },
		replies: [],
		addressed: undefined,
		resolution: undefined,
	});
	const markers = [mk(10, 20), mk(50, 60)];

	it('returns no decorations when nothing is selected (cleared on deselect)', () => {
		expect(
			planActiveCommentDecorations(null, markers, null, false),
		).toEqual([]);
	});

	it('returns no decorations when the active marker no longer exists', () => {
		expect(planActiveCommentDecorations(999, markers, null, false)).toEqual(
			[],
		);
	});

	it('returns no decorations when comments are hidden', () => {
		expect(
			planActiveCommentDecorations(10, markers, { from: 0, to: 9 }, true),
		).toEqual([]);
	});

	it('marks only the marker when the active comment has no resolvable anchor', () => {
		expect(planActiveCommentDecorations(10, markers, null, false)).toEqual([
			{ from: 10, to: 20, cls: ACTIVE_COMMENT_MARKER_CLASS },
		]);
	});

	it('marks the anchor and the marker, sorted, for a backward (end-placed) anchor', () => {
		// Anchor precedes the marker (legacy end-placement): anchor mark sorts first.
		expect(
			planActiveCommentDecorations(
				10,
				markers,
				{ from: 2, to: 10 },
				false,
			),
		).toEqual([
			{ from: 2, to: 10, cls: ACTIVE_COMMENT_CLASS },
			{ from: 10, to: 20, cls: ACTIVE_COMMENT_MARKER_CLASS },
		]);
	});

	it('marks the marker then the anchor, sorted, for a forward (begin-placed) anchor', () => {
		// Anchor follows the marker (begin-placement): marker mark sorts first.
		expect(
			planActiveCommentDecorations(
				10,
				markers,
				{ from: 20, to: 30 },
				false,
			),
		).toEqual([
			{ from: 10, to: 20, cls: ACTIVE_COMMENT_MARKER_CLASS },
			{ from: 20, to: 30, cls: ACTIVE_COMMENT_CLASS },
		]);
	});

	it('ignores an empty anchor range', () => {
		expect(
			planActiveCommentDecorations(
				50,
				markers,
				{ from: 40, to: 40 },
				false,
			),
		).toEqual([{ from: 50, to: 60, cls: ACTIVE_COMMENT_MARKER_CLASS }]);
	});
});

describe('resolveAnchorRange (F-273 direction-agnostic anchoring)', () => {
	const MARK = '<!-- annoteca/clarify: x -->';
	// Returns the substring the resolved range covers, so assertions read as the
	// underlined prose rather than raw offsets.
	const covered = (
		doc: string,
		markerStart: number,
		anchor: string,
	): string | null => {
		const r = resolveAnchorRange(
			doc,
			markerStart,
			markerStart + MARK.length,
			anchor,
		);
		return r ? doc.slice(r.from, r.to) : null;
	};

	describe('non-truncated', () => {
		it('matches a legacy end-placed marker (anchor before, with composer space)', () => {
			const anchor = 'assumes a hiring freeze';
			const doc = `${anchor} ${MARK} trailing`;
			expect(covered(doc, anchor.length + 1, anchor)).toBe(anchor);
		});

		it('matches a begin-placed marker (anchor after, with composer space)', () => {
			const anchor = 'assumes a hiring freeze';
			const doc = `${MARK} ${anchor} trailing`;
			expect(covered(doc, 0, anchor)).toBe(anchor);
		});

		it('matches an end-placed marker flush against the anchor (no space)', () => {
			const anchor = 'flush text';
			const doc = `${anchor}${MARK}`;
			expect(covered(doc, anchor.length, anchor)).toBe(anchor);
		});

		it('matches a begin-placed marker flush against the anchor (no space)', () => {
			const anchor = 'flush text';
			const doc = `${MARK}${anchor} more`;
			expect(covered(doc, 0, anchor)).toBe(anchor);
		});

		it('returns null when neither side matches', () => {
			const doc = `nothing relevant here ${MARK} or here`;
			expect(covered(doc, 22, 'absent anchor')).toBeNull();
		});
	});

	describe('truncated head…tail', () => {
		const full = 'AAAA BBBB CCCC DDDD';
		const anchor = 'AAAA…DDDD';

		it('spans the whole original for a legacy end-placed marker', () => {
			const doc = `${full} ${MARK}`;
			expect(covered(doc, full.length + 1, anchor)).toBe(full);
		});

		it('spans the whole original for a begin-placed marker', () => {
			const doc = `${MARK} ${full} after`;
			expect(covered(doc, 0, anchor)).toBe(full);
		});

		it('returns null when the tail/head cannot be located on either side', () => {
			const doc = `AAAA only no tail ${MARK}`;
			expect(covered(doc, 18, anchor)).toBeNull();
		});
	});

	it('round-trips: a legacy end-placed serialized marker still resolves via the parser', () => {
		// Build the document the OLD composer produced: `<selection> <marker>`.
		const selection = 'the original commented passage';
		const anchor = buildAnchorFromSelection(selection);
		expect(anchor).toBeDefined();
		if (!anchor) return;
		const marker = serialize({
			id: 'a1b2c3d4',
			category: 'clarify',
			body: 'needs work',
			date: '2026-06-20',
			anchor,
		});
		const doc = `${selection} ${marker}\n\nMore prose.`;
		const comments = parseAll(doc);
		expect(comments).toHaveLength(1);
		const c = comments[0];
		if (!c || !c.anchor) throw new Error('comment did not parse');
		const r = resolveAnchorRange(
			doc,
			c.marker.start,
			c.marker.end,
			c.anchor.text,
		);
		expect(r).not.toBeNull();
		if (r) expect(doc.slice(r.from, r.to)).toBe(selection);
	});

	it('round-trips: a new begin-placed serialized marker resolves via the parser', () => {
		const selection = 'the original commented passage';
		const anchor = buildAnchorFromSelection(selection);
		if (!anchor) return;
		const marker = serialize({
			id: 'a1b2c3d4',
			category: 'clarify',
			body: 'needs work',
			date: '2026-06-20',
			anchor,
		});
		// The NEW composer produces: `<marker> <selection>`.
		const doc = `${marker} ${selection}\n\nMore prose.`;
		const comments = parseAll(doc);
		const c = comments[0];
		if (!c || !c.anchor) throw new Error('comment did not parse');
		const r = resolveAnchorRange(
			doc,
			c.marker.start,
			c.marker.end,
			c.anchor.text,
		);
		expect(r).not.toBeNull();
		if (r) expect(doc.slice(r.from, r.to)).toBe(selection);
	});
});

describe('authorColorFor (F-275)', () => {
	const styles: AuthorStyle[] = [
		{ tag: 'charles', color: '#3366ff' },
		{ tag: 'claude' },
	];

	it('returns the configured color for a styled author', () => {
		expect(authorColorFor('charles', styles)).toBe('#3366ff');
	});

	it('returns undefined for an author with no color', () => {
		expect(authorColorFor('claude', styles)).toBeUndefined();
	});

	it('returns undefined for an unknown author', () => {
		expect(authorColorFor('nobody', styles)).toBeUndefined();
	});

	it('is case-sensitive (author tags are stored verbatim)', () => {
		expect(authorColorFor('Charles', styles)).toBeUndefined();
	});
});

describe('authorPickerOptions (F-274)', () => {
	const styles: AuthorStyle[] = [{ tag: 'claude' }, { tag: 'beta-reader' }];

	it('orders global tag first, then styles, then thread authors, deduped', () => {
		expect(
			authorPickerOptions('charles', styles, ['claude', 'guest']),
		).toEqual(['charles', 'claude', 'beta-reader', 'guest']);
	});

	it('drops blank and whitespace-only tags', () => {
		expect(authorPickerOptions('', [{ tag: '  ' }], ['', 'ai'])).toEqual([
			'ai',
		]);
	});

	it('does not duplicate an author present in several sources', () => {
		expect(authorPickerOptions('ai', [{ tag: 'ai' }], ['ai'])).toEqual([
			'ai',
		]);
	});

	it('returns an empty list when there are no authors at all', () => {
		expect(authorPickerOptions(undefined, [], [])).toEqual([]);
	});
});

describe('computeScopeFileSet', () => {
	const mk = (
		path: string,
		extras: Partial<Omit<ScopeFile, 'path'>> = {},
	): ScopeFile => ({
		path,
		parentPath: extras.parentPath,
		isInRoot: extras.isInRoot ?? false,
		frontmatter: extras.frontmatter,
		tags: extras.tags ?? [],
	});

	const files: ScopeFile[] = [
		mk('root.md', { parentPath: '', isInRoot: true, tags: ['#draft'] }),
		mk('docs/intro.md', {
			parentPath: 'docs',
			frontmatter: { status: 'wip' },
		}),
		mk('docs/api.md', {
			parentPath: 'docs',
			frontmatter: { status: 'done', topics: ['auth', 'api'] },
		}),
		mk('docs/nested/deep.md', {
			parentPath: 'docs/nested',
			tags: ['#draft', '#review'],
		}),
	];

	const shape = (s: ScopeShape) => s;

	it('file scope returns just the anchor path', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'file' }),
				'docs/intro.md',
			),
		).toEqual(new Set(['docs/intro.md']));
	});

	it('file scope with undefined anchor returns empty set', () => {
		expect(
			computeScopeFileSet(files, shape({ kind: 'file' }), undefined),
		).toEqual(new Set<string>());
	});

	it('vault scope returns every path', () => {
		expect(
			computeScopeFileSet(files, shape({ kind: 'vault' }), undefined),
		).toEqual(
			new Set([
				'root.md',
				'docs/intro.md',
				'docs/api.md',
				'docs/nested/deep.md',
			]),
		);
	});

	it('folder scope without subfolders returns only direct children', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'folder', subfolders: false }),
				'docs',
			),
		).toEqual(new Set(['docs/intro.md', 'docs/api.md']));
	});

	it('folder scope with subfolders returns descendants too', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'folder', subfolders: true }),
				'docs',
			),
		).toEqual(
			new Set(['docs/intro.md', 'docs/api.md', 'docs/nested/deep.md']),
		);
	});

	it('folder scope with empty anchor + no subfolders returns root files only', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'folder', subfolders: false }),
				'',
			),
		).toEqual(new Set(['root.md']));
	});

	it('folder scope with empty anchor + subfolders returns all files', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'folder', subfolders: true }),
				'',
			),
		).toEqual(
			new Set([
				'root.md',
				'docs/intro.md',
				'docs/api.md',
				'docs/nested/deep.md',
			]),
		);
	});

	it('property scope matches scalar frontmatter values', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'property', key: 'status', value: 'wip' }),
				undefined,
			),
		).toEqual(new Set(['docs/intro.md']));
	});

	it('property scope matches values inside an array-valued frontmatter key', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'property', key: 'topics', value: 'auth' }),
				undefined,
			),
		).toEqual(new Set(['docs/api.md']));
	});

	it('tag scope matches files carrying the tag (with leading #)', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'tag', tag: '#draft' }),
				undefined,
			),
		).toEqual(new Set(['root.md', 'docs/nested/deep.md']));
	});

	it('tag scope prepends # when the input lacks one', () => {
		expect(
			computeScopeFileSet(
				files,
				shape({ kind: 'tag', tag: 'draft' }),
				undefined,
			),
		).toEqual(new Set(['root.md', 'docs/nested/deep.md']));
	});
});
