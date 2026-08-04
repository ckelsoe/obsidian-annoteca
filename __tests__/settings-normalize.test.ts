import {
	normalizeRenderMarkdownBodies,
	mergeRestoredSettings,
	DEFAULT_SETTINGS,
} from '../settings';
import type { AnnotecaSettings } from '../types';

// data.json is user-editable and also arrives over sync and out of a restored
// backup, so a stored value is not guaranteed to be the type it was written as.
// Every read of this setting is a truthiness test, so a stored string "false"
// would silently turn a disabled setting back on.
describe('normalizeRenderMarkdownBodies', () => {
	it('keeps a real boolean, either way', () => {
		expect(normalizeRenderMarkdownBodies(true, false)).toBe(true);
		expect(normalizeRenderMarkdownBodies(false, true)).toBe(false);
	});

	it('rejects the string "false", which is truthy and would re-enable the setting', () => {
		expect(normalizeRenderMarkdownBodies('false', false)).toBe(false);
	});

	it('rejects every other non-boolean a hand-edited file can carry', () => {
		for (const stored of ['true', 0, 1, null, {}, [], 'yes', NaN]) {
			expect(normalizeRenderMarkdownBodies(stored, false)).toBe(false);
			expect(normalizeRenderMarkdownBodies(stored, true)).toBe(true);
		}
	});

	it('treats absent as "use the fallback", not as a rejection', () => {
		// This is the distinction the restore path depends on. A backup that
		// does not carry the key must leave the current value alone, the way
		// every other key in that spread does; falling back to the shipped
		// default there would silently overwrite the user's choice.
		expect(normalizeRenderMarkdownBodies(undefined, true)).toBe(true);
		expect(normalizeRenderMarkdownBodies(undefined, false)).toBe(false);
	});
});

describe('mergeRestoredSettings', () => {
	const liveWith = (over: Partial<AnnotecaSettings>): AnnotecaSettings => ({
		...DEFAULT_SETTINGS,
		...over,
	});

	it('takes the backup value over the live one', () => {
		const merged = mergeRestoredSettings(
			liveWith({ renderMarkdownBodies: true }),
			{ renderMarkdownBodies: false },
		);
		expect(merged.renderMarkdownBodies).toBe(false);
	});

	it('rejects a non-boolean in the backup instead of storing it', () => {
		// The whole point: restoring used to spread parsed JSON straight into
		// the live settings, so a hand-edited or synced backup carrying the
		// string "false" put a truthy value behind a truthiness test.
		const merged = mergeRestoredSettings(
			liveWith({ renderMarkdownBodies: false }),
			{
				renderMarkdownBodies: 'false',
			} as unknown as Partial<AnnotecaSettings>,
		);
		expect(merged.renderMarkdownBodies).toBe(false);
	});

	it('leaves the current value alone when the backup omits the key', () => {
		// Not the shipped default: a backup that says nothing about a setting
		// is not a request to reset it, and every other key here behaves that
		// way through the spread.
		const merged = mergeRestoredSettings(
			liveWith({
				renderMarkdownBodies: !DEFAULT_SETTINGS.renderMarkdownBodies,
			}),
			{},
		);
		expect(merged.renderMarkdownBodies).toBe(
			!DEFAULT_SETTINGS.renderMarkdownBodies,
		);
	});

	it('still restores every other key from the backup', () => {
		const merged = mergeRestoredSettings(liveWith({ authorTag: 'live' }), {
			authorTag: 'from-backup',
		});
		expect(merged.authorTag).toBe('from-backup');
	});

	it('fills a key the backup and the live settings both lack from the defaults', () => {
		const partial = { authorTag: 'x' } as unknown as AnnotecaSettings;
		expect(mergeRestoredSettings(partial, {}).defaultCategory).toBe(
			DEFAULT_SETTINGS.defaultCategory,
		);
	});
});
