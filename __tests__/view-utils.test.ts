import {
	formatStamp,
	truncate,
	resolveMarkerClickAction,
	replyCountLabel,
	planFlashRange,
} from '../view-utils';
import type { Comment } from '../types';

describe('view-utils: formatStamp', () => {
	it('renders a full timestamp as date and time, keeping seconds', () => {
		expect(formatStamp('2026-06-22T14:30:12')).toBe('2026-06-22 14:30:12');
	});

	it('renders a timestamp with no seconds as date plus HH:MM', () => {
		expect(formatStamp('2026-06-22T14:30')).toBe('2026-06-22 14:30');
	});

	it('passes a legacy date-only stamp through unchanged', () => {
		expect(formatStamp('2026-06-22')).toBe('2026-06-22');
	});
});

describe('view-utils: truncate', () => {
	it('returns text unchanged when within the limit', () => {
		expect(truncate('short', 10)).toBe('short');
	});

	it('returns text unchanged when exactly at the limit', () => {
		expect(truncate('exactly10!', 10)).toBe('exactly10!');
	});

	it('cuts to the limit and appends a single ellipsis when over', () => {
		expect(truncate('abcdefghij', 5)).toBe('abcde…');
	});
});

describe('view-utils: resolveMarkerClickAction', () => {
	it('honours a stored choice on desktop', () => {
		expect(resolveMarkerClickAction('popover', false)).toBe('popover');
		expect(resolveMarkerClickAction('panel', false)).toBe('panel');
	});

	// The important half. A user who deliberately picked "panel" on a phone
	// must keep it; if the platform were allowed to win over a stored value the
	// setting would silently revert every load and look broken.
	it('honours a stored choice on mobile, platform does not override it', () => {
		expect(resolveMarkerClickAction('panel', true)).toBe('panel');
		expect(resolveMarkerClickAction('popover', true)).toBe('popover');
	});

	it('falls back per platform when nothing is stored', () => {
		expect(resolveMarkerClickAction(undefined, false)).toBe('panel');
		expect(resolveMarkerClickAction(undefined, true)).toBe('popover');
	});

	// Settings come off disk and are not trusted. A value from a future version,
	// a hand-edited data.json, or null must not end up in the setting, because
	// nothing downstream re-validates it.
	it('treats an unrecognized stored value as absent', () => {
		expect(resolveMarkerClickAction('sidebar', false)).toBe('panel');
		expect(resolveMarkerClickAction('sidebar', true)).toBe('popover');
		expect(resolveMarkerClickAction(null, true)).toBe('popover');
		expect(resolveMarkerClickAction(42, false)).toBe('panel');
		expect(resolveMarkerClickAction('', true)).toBe('popover');
	});
});

describe('view-utils: replyCountLabel', () => {
	// Shared by the Hub panel badge and the marker tooltip. If these two ever
	// need to differ, that is a product decision, not something a second copy
	// of the ternary should decide by drifting.
	it('singularizes exactly one reply', () => {
		expect(replyCountLabel(1)).toBe('1 reply');
	});

	it('pluralizes every other count', () => {
		expect(replyCountLabel(0)).toBe('0 replies');
		expect(replyCountLabel(2)).toBe('2 replies');
		expect(replyCountLabel(12)).toBe('12 replies');
	});
});

describe('view-utils: planFlashRange (#82)', () => {
	// Marker occupies [10, 20). Offsets past it are the prose that follows.
	const comment = (addressed: boolean): Comment =>
		({
			category: 'clarify',
			body: 'b',
			replies: [],
			marker: { start: 10, end: 20 },
			addressed: addressed
				? { author: 'ai', date: '2026-06-20', note: 'n' }
				: undefined,
		}) as unknown as Comment;
	const text = (doc: string) => ({
		charAt: (pos: number) => doc.charAt(pos),
		lineEndAt: (pos: number) => {
			const lf = doc.indexOf('\n', pos);
			return lf === -1 ? doc.length : lf;
		},
	});
	const plan = (
		c: Comment,
		doc: string,
		anchor: { from: number; to: number } | null = null,
		hideAll = false,
	) => {
		const t = text(doc);
		return planFlashRange(c, anchor, t.charAt, t.lineEndAt, hideAll);
	};
	const pad = 'x'.repeat(20);

	it('addressed: skips the single space and stops at the line end', () => {
		expect(plan(comment(true), `${pad} new text\nnext`)).toEqual({
			from: 21,
			to: 29,
		});
	});

	it('addressed: with no space, starts right at the marker end', () => {
		expect(plan(comment(true), `${pad}new\n`)).toEqual({
			from: 20,
			to: 23,
		});
	});

	it('addressed with nothing after the marker falls back to the anchor', () => {
		expect(plan(comment(true), `${pad}\nnext`, { from: 0, to: 5 })).toEqual(
			{
				from: 0,
				to: 5,
			},
		);
	});

	it('open comment: anchor wins over the marker', () => {
		expect(plan(comment(false), `${pad} new`, { from: 2, to: 8 })).toEqual({
			from: 2,
			to: 8,
		});
	});

	it('open comment with no anchor: the marker itself', () => {
		expect(plan(comment(false), pad)).toEqual({ from: 10, to: 20 });
	});

	it('an empty anchor range is ignored', () => {
		expect(plan(comment(false), pad, { from: 4, to: 4 })).toEqual({
			from: 10,
			to: 20,
		});
	});

	it('nothing while every comment is hidden', () => {
		expect(plan(comment(true), `${pad} new`, null, true)).toBeNull();
	});
});
