import {
	formatStamp,
	truncate,
	resolveMarkerClickAction,
	replyCountLabel,
} from '../view-utils';

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
