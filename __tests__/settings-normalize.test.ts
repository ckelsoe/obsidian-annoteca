import {
	normalizeSettings,
	reconcileDefaultCategory,
	mergeRestoredSettings,
	resolveSettingsCategories,
	DEFAULT_SETTINGS,
} from '../settings';
import { resolveEnabledCategories, DEFAULT_CATEGORIES } from '../categories';
import type { AnnotecaSettings } from '../types';

// data.json is user-editable and also arrives over sync and out of a restored
// backup, so nothing in it is guaranteed to be the type it was written as.
// normalizeSettings is the single ingress; these are the shapes a hand-edited
// or synced file actually produces.

const defaultIds = DEFAULT_CATEGORIES.map((c) => c.id);

describe('normalizeSettings: the shipped defaults are a fixed point', () => {
	it('returns the defaults unchanged for an empty, absent or non-object blob', () => {
		for (const raw of [{}, null, undefined, 'nonsense', 42, []]) {
			expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
		}
	});

	it('accepts its own defaults back', () => {
		// A validator that rejects the value it is defaulting to would be
		// invisible otherwise: every load would still look correct because the
		// rejection and the default agree.
		expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
	});

	it('hands back no reference into DEFAULT_SETTINGS', () => {
		// The settings UI edits categories and author styles in place. Sharing
		// the array or its objects would mean every later load started from the
		// mutated set, in this process and in the test suite.
		const s = normalizeSettings({});
		expect(s.categories).not.toBe(DEFAULT_SETTINGS.categories);
		s.categories[0]!.displayName = 'mutated';
		s.categories.push({ id: 'extra', displayName: 'Extra' });
		expect(DEFAULT_SETTINGS.categories).toHaveLength(defaultIds.length);
		expect(DEFAULT_SETTINGS.categories[0]?.displayName).not.toBe('mutated');
	});

	it('hands back no reference into DEFAULT_SETTINGS on the bare-default leg either', () => {
		// The call shape that matters: an explicit fallback carrying none of the
		// keys, so every one of them falls all the way through to the shipped
		// default. Passing DEFAULT_SETTINGS as the fallback (the common case)
		// hides this, because the fallback leg re-validates and that is what
		// builds a fresh object.
		//
		// Written over every structural key rather than over `categories` alone,
		// so a validator added later that returns its input by reference is
		// caught here rather than by a user whose defaults got edited in place.
		const s = normalizeSettings({}, {});
		const structural = (
			Object.keys(DEFAULT_SETTINGS) as (keyof AnnotecaSettings)[]
		).filter((key) => typeof DEFAULT_SETTINGS[key] === 'object');
		expect(structural.length).toBeGreaterThanOrEqual(5);
		for (const key of structural) {
			expect([key, s[key] === DEFAULT_SETTINGS[key]]).toEqual([
				key,
				false,
			]);
		}
	});
});

describe('normalizeSettings: structural keys', () => {
	it('survives categories stored as an object, the executed repro', () => {
		// resolveEnabledCategories does `for (const c of customCategories)`, so a
		// stored `{}` threw on the first iteration and took the whole load with
		// it. Nothing downstream was reachable.
		const s = normalizeSettings({ categories: {} });
		expect(s.categories.map((c) => c.id)).toEqual(defaultIds);
		expect(() =>
			resolveEnabledCategories(s.categories, s.enableScholarlyPreset),
		).not.toThrow();
	});

	it('survives categories stored as a string', () => {
		const s = normalizeSettings({ categories: 'abc' });
		expect(s.categories.map((c) => c.id)).toEqual(defaultIds);
	});

	it('restores the shipped set when every stored category is unusable', () => {
		// An empty working list is not a usable state: the composer dropdown and
		// the sidebar grouping both read it.
		const s = normalizeSettings({
			categories: [null, 'tone', { id: 'Has Spaces' }, { id: 42 }, {}],
		});
		expect(s.categories.map((c) => c.id)).toEqual(defaultIds);
	});

	it('drops only the bad elements when some categories are usable', () => {
		const s = normalizeSettings({
			categories: [
				{ id: 'tone', displayName: 'Tone' },
				{ id: 'Not Valid' },
				{ id: 'cut', displayName: 'Cut' },
			],
		});
		expect(s.categories.map((c) => c.id)).toEqual(['tone', 'cut']);
	});

	it('derives a missing display name instead of dropping the category', () => {
		// Dropping it would strand every comment already filed under that id.
		const s = normalizeSettings({
			categories: [
				{ id: 'source-needed' },
				{ id: 'tone', displayName: 7 },
			],
		});
		expect(s.categories).toEqual([
			{ id: 'source-needed', displayName: 'Source needed' },
			{ id: 'tone', displayName: 'Tone' },
		]);
	});

	it('keeps a stored category the parser can read but the UI would not create', () => {
		// isValidCategoryName is the house style for a name being CREATED in the
		// settings UI, and is stricter than the marker grammar: no double dashes,
		// no trailing dash, no format keywords. All of those round-trip through a
		// marker perfectly well, so validating stored data against the creation
		// rule deletes a working category, its icon, its color and its display
		// name, and leaves every comment filed under it unselectable.
		const stored = [
			{ id: 'my--topic', displayName: 'My topic', color: '#abcdef' },
			{ id: 'trailing-', displayName: 'Trailing' },
			{ id: 'reply', displayName: 'Reply' },
		];
		const s = normalizeSettings({ categories: stored });
		expect(s.categories).toEqual(stored);
	});

	it('still drops a category id the marker grammar cannot hold', () => {
		// The other half of the same rule: these cannot be written back, so a
		// comment filed under one would be invisible after the next write.
		const s = normalizeSettings({
			categories: [
				{ id: 'tone', displayName: 'Tone' },
				{ id: 'Has Spaces' },
				{ id: 'UPPER' },
				{ id: '9leading' },
				{ id: 'holds]bracket' },
				{ id: '' },
			],
		});
		expect(s.categories.map((c) => c.id)).toEqual(['tone']);
	});

	it('keeps only the category fields that type-check', () => {
		const s = normalizeSettings({
			categories: [
				{
					id: 'tone',
					displayName: 'Tone',
					icon: 42,
					color: 'var(--color-purple)',
					tier: 'nonsense',
				},
			],
		});
		expect(s.categories[0]).toEqual({
			id: 'tone',
			displayName: 'Tone',
			color: 'var(--color-purple)',
		});
	});

	it('keeps only string ids in starredComments', () => {
		// main.ts does `starredComments.includes(comment.id)` and the Starred tab
		// walks it in reverse; a number in there is a card that can never draw.
		const s = normalizeSettings({
			starredComments: ['abcd1234', 42, null, 'efgh5678', {}],
		});
		expect(s.starredComments).toEqual(['abcd1234', 'efgh5678']);
	});

	it('defaults starredComments when it is not an array at all', () => {
		expect(
			normalizeSettings({ starredComments: {} }).starredComments,
		).toEqual([]);
	});

	it('keeps only author styles with a usable tag', () => {
		const s = normalizeSettings({
			authorStyles: [
				{ tag: 'bob', color: '#ff0000' },
				{ tag: '' },
				{ tag: 42 },
				{ color: '#00ff00' },
				{ tag: 'ann', color: 7 },
			],
		});
		expect(s.authorStyles).toEqual([
			{ tag: 'bob', color: '#ff0000' },
			{ tag: 'ann' },
		]);
	});

	it('keeps only presets that still have categories to offer', () => {
		const s = normalizeSettings({
			customPresets: [
				{
					id: 'mine',
					displayName: 'Mine',
					categories: [{ id: 'tone', displayName: 'Tone' }],
				},
				{ id: 'empty', displayName: 'Empty', categories: [] },
				{ id: 'broken', displayName: 'Broken', categories: 'nope' },
				{ displayName: 'No id', categories: [{ id: 'tone' }] },
			],
		});
		expect(s.customPresets).toEqual([
			{
				id: 'mine',
				displayName: 'Mine',
				categories: [{ id: 'tone', displayName: 'Tone' }],
			},
		]);
	});

	// The default scope shape IS `{ kind: 'file' }`, so asserting that a bad
	// shape lands on the default cannot tell rejection apart from silently
	// coercing every unknown kind to "file". Both tests below run against a
	// fallback holding a DIFFERENT shape, which makes the difference visible.
	const vaultScope: AnnotecaSettings = {
		...DEFAULT_SETTINGS,
		scopeState: { shape: { kind: 'vault' }, anchorPath: '', pinned: true },
	};

	it('rejects a scope state whose shape kind is unknown', () => {
		// scope.ts switches on the kind. An unknown one resolves to no files,
		// which reads as a broken panel rather than as a bad stored value.
		for (const shape of [{ kind: 'nonsense' }, {}, 'file', null, 42]) {
			expect(
				normalizeSettings({ scopeState: { shape } }, vaultScope)
					.scopeState,
			).toEqual(vaultScope.scopeState);
		}
	});

	it('rejects a scope shape missing the fields its kind requires', () => {
		expect(
			normalizeSettings(
				{ scopeState: { shape: { kind: 'property', key: 'status' } } },
				vaultScope,
			).scopeState,
		).toEqual(vaultScope.scopeState);
		expect(
			normalizeSettings(
				{ scopeState: { shape: { kind: 'tag', tag: 42 } } },
				vaultScope,
			).scopeState,
		).toEqual(vaultScope.scopeState);
	});

	it('keeps each scope kind the union actually defines', () => {
		const shapes = [
			{ kind: 'file' },
			{ kind: 'vault' },
			{ kind: 'folder', subfolders: true },
			{ kind: 'property', key: 'status', value: 'draft' },
			{ kind: 'tag', tag: '#review' },
		];
		for (const shape of shapes) {
			expect(
				normalizeSettings({ scopeState: { shape } }, vaultScope)
					.scopeState.shape,
			).toEqual(shape);
		}
	});

	it('keeps a well-formed scope state and repairs its loose fields', () => {
		const s = normalizeSettings({
			scopeState: {
				shape: { kind: 'folder', subfolders: 'yes' },
				anchorPath: 42,
				pinned: 'yes',
			},
		});
		expect(s.scopeState).toEqual({
			shape: { kind: 'folder', subfolders: false },
			anchorPath: '',
			pinned: false,
		});
	});

	it('keeps the optional keys that carry no default', () => {
		// These are absent from DEFAULT_SETTINGS. A normalizer that only copied
		// keys it had defaults for would silently delete a user's drift snapshots
		// and re-fire the skill staleness notice on every load.
		const s = normalizeSettings({
			driftSnapshots: {
				abcd1234: { before: 'was', after: 'now' },
				broken: { before: 42 },
			},
			exportedSkillVersion: 3,
			skillStaleNoticeShownFor: 2,
		});
		expect(s.driftSnapshots).toEqual({
			abcd1234: { before: 'was', after: 'now' },
		});
		expect(s.exportedSkillVersion).toBe(3);
		expect(s.skillStaleNoticeShownFor).toBe(2);
	});

	it('keeps a drift snapshot stored under a __proto__ key', () => {
		// The KEYS here are untrusted too, not just the values. On a plain object
		// literal `out['__proto__'] = snap` runs the inherited setter instead of
		// creating a key, so the snapshot vanishes and the accumulator ends up
		// with a prototype nobody asked for.
		//
		// Built with JSON.parse, not an object literal: `__proto__:` in a literal
		// is the prototype-setter syntax and never creates an own key, so a
		// literal here would test nothing. JSON.parse is also how the value
		// really arrives.
		const s = normalizeSettings(
			JSON.parse(
				'{"driftSnapshots":{"__proto__":{"before":"was","after":"now"},"abcd1234":{"before":"a","after":"b"}}}',
			),
		);
		expect(Object.keys(s.driftSnapshots ?? {}).sort()).toEqual([
			'__proto__',
			'abcd1234',
		]);
		expect(s.driftSnapshots?.['__proto__']).toEqual({
			before: 'was',
			after: 'now',
		});
		// And nothing leaked onto Object.prototype along the way.
		expect(({} as Record<string, unknown>).before).toBeUndefined();
	});

	it('leaves an optional key absent rather than storing an explicit undefined', () => {
		const s = normalizeSettings({ exportedSkillVersion: 'three' });
		expect('exportedSkillVersion' in s).toBe(false);
		expect('driftSnapshots' in s).toBe(false);
	});
});

describe('normalizeSettings: booleans', () => {
	// Enumerated from DEFAULT_SETTINGS rather than listed, so a boolean setting
	// added later is covered here the day it is added. The build already forces
	// it to have a validator; this forces that validator to be the boolean gate.
	const booleanKeys = (
		Object.entries(DEFAULT_SETTINGS) as [keyof AnnotecaSettings, unknown][]
	)
		.filter(([, value]) => typeof value === 'boolean')
		.map(([key]) => key);

	it('covers every boolean the settings interface has', () => {
		// Guards the guard: if this list ever comes back empty the loops below
		// pass while asserting nothing.
		expect(booleanKeys.length).toBeGreaterThanOrEqual(12);
	});

	it('rejects the string "yes" for every boolean key', () => {
		for (const key of booleanKeys) {
			const s = normalizeSettings({ [key]: 'yes' });
			expect([key, s[key]]).toEqual([key, DEFAULT_SETTINGS[key]]);
		}
	});

	it('rejects the string "false", which is truthy and would re-enable a setting', () => {
		// Every read of these is a truthiness test, so this is the shape that
		// actually silently flips a disabled setting back on.
		for (const key of booleanKeys) {
			const live = { ...DEFAULT_SETTINGS, [key]: false };
			const s = normalizeSettings({ [key]: 'false' }, live);
			expect([key, s[key]]).toEqual([key, false]);
		}
	});

	it('rejects every other non-boolean a hand-edited file can carry', () => {
		for (const stored of ['true', 0, 1, null, {}, [], NaN]) {
			for (const key of booleanKeys) {
				const s = normalizeSettings({ [key]: stored });
				expect([key, s[key]]).toEqual([key, DEFAULT_SETTINGS[key]]);
			}
		}
	});

	it('keeps a real boolean, either way', () => {
		for (const key of booleanKeys) {
			expect(normalizeSettings({ [key]: true })[key]).toBe(true);
			expect(normalizeSettings({ [key]: false })[key]).toBe(false);
		}
	});
});

describe('normalizeSettings: enum strings', () => {
	const cases: Array<[keyof AnnotecaSettings, string]> = [
		['indicatorStyle', 'underline'],
		['defaultVisibility', 'hide'],
		['hoverDelay', 'relaxed'],
		['markerClickAction', 'popover'],
		['anchorStyle', 'dotted'],
		['anchorThickness', 'thick'],
		['resolvedBrightness', 'bright'],
		['resolvedDisplay', 'hide'],
		['composerLocation', 'modal'],
		['markerScrollAlign', 'minimal'],
		['debugLogTarget', 'vault'],
		['lastHubTab', 'outline'],
		['statusFilter', 'resolved'],
		['indicatorSize', 'large'],
		['skillExportTarget', 'both'],
		['readingViewIndicator', 'per-section'],
	];

	it.each(cases)('keeps a valid %s', (key, valid) => {
		expect(normalizeSettings({ [key]: valid })[key]).toBe(valid);
	});

	it.each(cases)('defaults %s when the stored value is garbage', (key) => {
		for (const bad of ['garbage', '', 42, null, {}, []]) {
			expect(normalizeSettings({ [key]: bad })[key]).toBe(
				DEFAULT_SETTINGS[key],
			);
		}
	});

	it('sends an unknown hub tab back to thread', () => {
		// views.ts switches on this to pick a renderer.
		expect(normalizeSettings({ lastHubTab: 'garbage' }).lastHubTab).toBe(
			'thread',
		);
	});
});

describe('normalizeSettings: authorTag', () => {
	it('repairs a display name into a token instead of discarding it', () => {
		// A tag with a space makes the [author=...] line unparseable, so the walk
		// breaks on it and the entire trailing block collapses into the body.
		expect(normalizeSettings({ authorTag: 'Bob Smith' }).authorTag).toBe(
			'Bob-Smith',
		);
	});

	it('keeps the empty tag, which is what "no tag set" looks like', () => {
		// Sanitizing it would invent the token "user" for someone who never
		// asked for one.
		expect(normalizeSettings({ authorTag: '' }).authorTag).toBe('');
	});

	it('trims a padded tag, which is what downstream readers rely on', () => {
		// CommentService.resolvedAuthor used to trim for itself. It no longer
		// does, so the trim has to happen here or a padded tag reaches the
		// [author=...] line, fails the grammar, and breaks the walk.
		expect(normalizeSettings({ authorTag: '  charles  ' }).authorTag).toBe(
			'charles',
		);
	});

	it('keeps a tag that already matches the grammar, casing included', () => {
		expect(normalizeSettings({ authorTag: 'Reviewer.2' }).authorTag).toBe(
			'Reviewer.2',
		);
	});

	it('strips the characters that would break the marker itself', () => {
		expect(normalizeSettings({ authorTag: 'a<b>c]d' }).authorTag).toBe(
			'abcd',
		);
	});

	it('defaults a non-string tag rather than stringifying it', () => {
		for (const bad of [42, null, {}, []]) {
			expect(normalizeSettings({ authorTag: bad }).authorTag).toBe(
				DEFAULT_SETTINGS.authorTag,
			);
		}
	});
});

describe('reconcileDefaultCategory', () => {
	it('repoints a default stranded by turning the index-entry preset off', () => {
		// The category is gone from the offered set, so the composer would open
		// with nothing selected.
		const s = normalizeSettings({
			enableIndexEntryPreset: false,
			defaultCategory: 'index-entry',
		});
		expect(s.defaultCategory).toBe(defaultIds[0]);
		expect(
			resolveSettingsCategories(s).some(
				(c) => c.id === s.defaultCategory,
			),
		).toBe(true);
	});

	it('leaves the default alone while the preset supplying it is on', () => {
		const s = normalizeSettings({
			enableIndexEntryPreset: true,
			defaultCategory: 'index-entry',
		});
		expect(s.defaultCategory).toBe('index-entry');
	});

	it('repoints a default stranded by turning the scholarly preset off', () => {
		const s = normalizeSettings({
			enableScholarlyPreset: false,
			defaultCategory: 'meditation',
		});
		expect(s.defaultCategory).toBe(defaultIds[0]);
	});

	it('repoints a default that was never a category at all', () => {
		expect(
			normalizeSettings({ defaultCategory: 'never-existed' })
				.defaultCategory,
		).toBe(defaultIds[0]);
	});

	it('reports whether it changed anything', () => {
		// The settings tab uses the return value to decide whether to tell the
		// user their default moved.
		const stranded = {
			...DEFAULT_SETTINGS,
			defaultCategory: 'index-entry',
			enableIndexEntryPreset: false,
		};
		expect(reconcileDefaultCategory(stranded)).toBe(true);
		expect(reconcileDefaultCategory(stranded)).toBe(false);
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

	it('falls back to the LIVE value when the backup gets a key wrong', () => {
		// Not to the shipped default. One bad line in a backup must not quietly
		// reset a setting the user never touched, and restoring used to spread
		// parsed JSON straight into the live settings, so the string "false"
		// landed behind a truthiness test.
		const merged = mergeRestoredSettings(
			liveWith({ renderMarkdownBodies: false }),
			{
				renderMarkdownBodies: 'false',
			} as unknown as Partial<AnnotecaSettings>,
		);
		expect(merged.renderMarkdownBodies).toBe(false);
		expect(DEFAULT_SETTINGS.renderMarkdownBodies).toBe(true);
	});

	it('leaves the current value alone when the backup omits the key', () => {
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

	it('survives a backup carrying categories as an object, the executed repro', () => {
		// The restore path is the same untrusted shape as data.json. Before the
		// merge went through normalizeSettings this stored `{}` on the live
		// settings and the next category read threw.
		const merged = mergeRestoredSettings(DEFAULT_SETTINGS, {
			categories: {},
		} as unknown as Partial<AnnotecaSettings>);
		expect(merged.categories.map((c) => c.id)).toEqual(defaultIds);
		expect(() => resolveSettingsCategories(merged)).not.toThrow();
	});

	it('normalizes a live value the backup does not mention', () => {
		// The fallback is validated too, not trusted, so a live settings object
		// that was already corrupt cannot survive a restore.
		const merged = mergeRestoredSettings(
			{
				...DEFAULT_SETTINGS,
				lastHubTab: 'garbage',
			} as unknown as AnnotecaSettings,
			{},
		);
		expect(merged.lastHubTab).toBe('thread');
	});

	it('hands back no reference into the live settings it was given', () => {
		const live = liveWith({});
		const merged = mergeRestoredSettings(live, {});
		expect(merged.categories).not.toBe(live.categories);
		merged.categories.push({ id: 'extra', displayName: 'Extra' });
		expect(live.categories).toHaveLength(defaultIds.length);
	});
});
