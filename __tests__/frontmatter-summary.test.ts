import type { Comment } from '../types';
import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import {
	applyFrontmatterSummary,
	writeSummaryKeys,
	computeSummary,
	mergeFileclass,
	fileclassHasAnnoteca,
	frontmatterMatches,
	isManagedNote,
	isReservedProperty,
	DEFAULT_FILECLASS_PROPERTY,
	type FrontmatterSummaryOptions,
	type DesiredSummary,
} from '../frontmatter-summary';

const OPTS: FrontmatterSummaryOptions = {
	includeOldestOpen: true,
	includeCategories: true,
	writeClassTag: true,
	fileclassProperty: 'fileclass',
};

function mk(over: Partial<Comment>): Comment {
	return {
		id: undefined,
		category: 'clarify',
		body: '',
		date: undefined,
		author: undefined,
		anchor: undefined,
		replies: [],
		addressed: undefined,
		resolution: undefined,
		unknownLines: [],
		source: undefined,
		marker: {} as Comment['marker'],
		...over,
	};
}

const resolved = (over: Partial<Comment> = {}): Comment =>
	mk({ resolution: {} as Comment['resolution'], ...over });

describe('computeSummary', () => {
	it('counts nothing for an empty file', () => {
		expect(computeSummary([], OPTS)).toEqual({ open: 0 });
	});

	it('counts open comments and omits resolved ones', () => {
		const s = computeSummary(
			[
				mk({ category: 'tone', date: '2026-05-23' }),
				mk({ category: 'source', date: '2026-05-20' }),
				resolved({ category: 'cut', date: '2026-01-01' }),
			],
			OPTS,
		);
		expect(s.open).toBe(2);
		expect(s.oldestOpen).toBe('2026-05-20');
		expect(s.categories).toEqual(['source', 'tone']);
	});

	it('treats an addressed comment as open', () => {
		const s = computeSummary(
			[mk({ addressed: {} as Comment['addressed'], category: 'tone' })],
			OPTS,
		);
		expect(s.open).toBe(1);
	});

	it('dedupes and sorts categories', () => {
		const s = computeSummary(
			[
				mk({ category: 'tone' }),
				mk({ category: 'tone' }),
				mk({ category: 'clarify' }),
			],
			OPTS,
		);
		expect(s.categories).toEqual(['clarify', 'tone']);
	});

	it('slices a full timestamp down to a date', () => {
		const s = computeSummary([mk({ date: '2026-05-23T14:05:00' })], OPTS);
		expect(s.oldestOpen).toBe('2026-05-23');
	});

	it('omits oldestOpen when no open comment carries a date', () => {
		const s = computeSummary([mk({ date: undefined })], OPTS);
		expect(s.oldestOpen).toBeUndefined();
	});

	it('omits extras when the toggles are off', () => {
		const s = computeSummary(
			[mk({ category: 'tone', date: '2026-05-23' })],
			{
				...OPTS,
				includeOldestOpen: false,
				includeCategories: false,
			},
		);
		expect(s).toEqual({ open: 1 });
	});

	it('drops extras entirely when everything is resolved', () => {
		const s = computeSummary(
			[resolved({ category: 'tone', date: '2026-05-23' })],
			OPTS,
		);
		expect(s).toEqual({ open: 0 });
	});
});

describe('mergeFileclass', () => {
	it('creates a scalar when absent', () => {
		expect(mergeFileclass(undefined)).toEqual({
			value: 'annoteca',
			changed: true,
		});
	});

	it('is a no-op when the scalar already matches', () => {
		expect(mergeFileclass('annoteca')).toEqual({
			value: 'annoteca',
			changed: false,
		});
	});

	it('promotes a different scalar to a list, preserving it', () => {
		expect(mergeFileclass('mindmap')).toEqual({
			value: ['mindmap', 'annoteca'],
			changed: true,
		});
	});

	it('appends to an existing list without dropping values', () => {
		expect(mergeFileclass(['mindmap', 'tasknote'])).toEqual({
			value: ['mindmap', 'tasknote', 'annoteca'],
			changed: true,
		});
	});

	it('is a no-op when the list already contains the tag', () => {
		expect(mergeFileclass(['annoteca', 'mindmap'])).toEqual({
			value: ['annoteca', 'mindmap'],
			changed: false,
		});
	});

	it('leaves an unrecognised shape untouched', () => {
		const obj = { nested: true };
		expect(mergeFileclass(obj)).toEqual({ value: obj, changed: false });
	});
});

describe('fileclassHasAnnoteca', () => {
	it('reads scalar, list, and absent forms', () => {
		expect(fileclassHasAnnoteca('annoteca')).toBe(true);
		expect(fileclassHasAnnoteca('other')).toBe(false);
		expect(fileclassHasAnnoteca(['a', 'annoteca'])).toBe(true);
		expect(fileclassHasAnnoteca(['a', 'b'])).toBe(false);
		expect(fileclassHasAnnoteca(undefined)).toBe(false);
	});
});

describe('frontmatterMatches', () => {
	const desired: DesiredSummary = {
		open: 2,
		oldestOpen: '2026-05-20',
		categories: ['source', 'tone'],
	};
	const match: Record<string, unknown> = {
		annoteca_open: 2,
		annoteca_oldest_open: '2026-05-20',
		annoteca_categories: ['source', 'tone'],
		fileclass: 'annoteca',
	};

	it('is true when everything already matches', () => {
		expect(frontmatterMatches(match, desired, 'fileclass')).toBe(true);
	});

	it('is false when the count differs', () => {
		expect(
			frontmatterMatches(
				{ ...match, annoteca_open: 1 },
				desired,
				'fileclass',
			),
		).toBe(false);
	});

	it('is false when the oldest date differs or is missing', () => {
		expect(
			frontmatterMatches(
				{ ...match, annoteca_oldest_open: '2026-05-21' },
				desired,
				'fileclass',
			),
		).toBe(false);
		const noDate = { ...match };
		delete noDate.annoteca_oldest_open;
		expect(frontmatterMatches(noDate, desired, 'fileclass')).toBe(false);
	});

	it('is false when categories differ', () => {
		expect(
			frontmatterMatches(
				{ ...match, annoteca_categories: ['tone'] },
				desired,
				'fileclass',
			),
		).toBe(false);
	});

	it('is false when the fileclass tag is missing', () => {
		expect(
			frontmatterMatches(
				{ ...match, fileclass: 'other' },
				desired,
				'fileclass',
			),
		).toBe(false);
	});

	it('treats an unmergeable fileclass value as satisfied, so it cannot loop', () => {
		// A number or object can never take the tag; mergeFileclass leaves it
		// alone, so the guard must agree or the writer rewrites every tick.
		expect(
			frontmatterMatches(
				{ ...match, fileclass: 42 },
				desired,
				'fileclass',
			),
		).toBe(true);
	});

	it('ignores the class property when the class tag is opt-out', () => {
		// writeClassTag=false: the class property is not written, so its absence
		// must not force a rewrite.
		const noClass = {
			annoteca_open: 2,
			annoteca_oldest_open: '2026-05-20',
			annoteca_categories: ['source', 'tone'],
		};
		expect(frontmatterMatches(noClass, desired, 'fileclass', false)).toBe(
			true,
		);
		expect(frontmatterMatches(noClass, desired, 'fileclass', true)).toBe(
			false,
		);
	});

	it('requires the oldest date to be absent when none is desired', () => {
		const desiredNoDate: DesiredSummary = { open: 0 };
		expect(
			frontmatterMatches(
				{ annoteca_open: 0, fileclass: 'annoteca' },
				desiredNoDate,
				'fileclass',
			),
		).toBe(true);
		expect(
			frontmatterMatches(
				{
					annoteca_open: 0,
					annoteca_oldest_open: '2026-05-20',
					fileclass: 'annoteca',
				},
				desiredNoDate,
				'fileclass',
			),
		).toBe(false);
	});
});

describe('defaults', () => {
	it('defaults the class property to fileclass', () => {
		expect(DEFAULT_FILECLASS_PROPERTY).toBe('fileclass');
	});
});

describe('isReservedProperty', () => {
	it('reserves the managed summary fields, so the class tag cannot collide', () => {
		expect(isReservedProperty('annoteca_open')).toBe(true);
		expect(isReservedProperty('annoteca_oldest_open')).toBe(true);
		expect(isReservedProperty('annoteca_categories')).toBe(true);
		expect(isReservedProperty('fileclass')).toBe(false);
	});
});

describe('isManagedNote', () => {
	it('manages any note that has comments now', () => {
		expect(isManagedNote(true, {}, 'fileclass')).toBe(true);
	});

	it('keeps managing a cleared note that still carries the count', () => {
		expect(isManagedNote(false, { annoteca_open: 0 }, 'fileclass')).toBe(
			true,
		);
	});

	it('keeps managing a note tagged with the fileclass', () => {
		expect(
			isManagedNote(false, { fileclass: 'annoteca' }, 'fileclass'),
		).toBe(true);
	});

	it('leaves a note that never had a comment untouched', () => {
		expect(isManagedNote(false, { title: 'x' }, 'fileclass')).toBe(false);
	});
});

// Found by the Debug log: the summary wrote twice about a second apart. The
// metadata cache catches up with a write a moment after it lands, so an update
// scheduled in that moment saw the old values and wrote the same ones again.
describe('applyFrontmatterSummary against a lagging cache', () => {
	const opts: FrontmatterSummaryOptions = { ...OPTS, writeClassTag: false };
	const comments = [mk({ date: '2026-10-01', category: 'tone' })];
	const summary = {
		annoteca_open: 1,
		annoteca_oldest_open: '2026-10-01',
		annoteca_categories: ['tone'],
	};

	function fakeApp(cached: Record<string, unknown>) {
		const writes: string[] = [];
		let raw = '---\ntitle: T\n---\nBody.\n';
		const app = {
			metadataCache: { getFileCache: () => ({ frontmatter: cached }) },
			vault: {
				process: (_f: TFile, fn: (data: string) => string) => {
					raw = fn(raw);
					writes.push(raw);
					return Promise.resolve(raw);
				},
			},
		} as unknown as App;
		return { app, writes };
	}

	it('does not write again when the file already holds the summary', async () => {
		const first = fakeApp({});
		expect(
			await applyFrontmatterSummary(
				first.app,
				new TFile(),
				comments,
				opts,
			),
		).toBe(true);
		expect(first.writes[0]).toContain('annoteca_open: 1');

		// The cache still shows the note before that write; the file has it.
		const second = fakeApp({});
		const wrote = await applyFrontmatterSummary(
			second.app,
			new TFile(),
			comments,
			opts,
			undefined,
			() => Promise.resolve(summary),
		);
		expect(wrote).toBe(false);
		expect(second.writes).toHaveLength(0);
	});

	it('still writes when the file is out of date too', async () => {
		const { app, writes } = fakeApp({});
		const wrote = await applyFrontmatterSummary(
			app,
			new TFile(),
			comments,
			opts,
			undefined,
			() => Promise.resolve({}),
		);
		expect(wrote).toBe(true);
		expect(writes).toHaveLength(1);
	});

	it('does not write into frontmatter that does not parse', async () => {
		const { app, writes } = fakeApp({});
		await expect(
			applyFrontmatterSummary(
				app,
				new TFile(),
				comments,
				opts,
				undefined,
				undefined,
				() => {
					throw new Error('bad yaml');
				},
			),
		).rejects.toThrow('bad yaml');
		expect(writes).toHaveLength(0);
	});
});

describe('writeSummaryKeys', () => {
	const desired = {
		open: 2,
		oldestOpen: '2026-10-26',
		categories: ['clarify', 'decision-needed'],
	};

	it('changes only the summary keys, quotes and all', () => {
		const raw = [
			'---',
			'title: "Reading guide"',
			'document: "rg"',
			"date: '2026-10-26'",
			'answers: []',
			'annoteca_open: 1',
			'annoteca_categories:',
			'  - clarify',
			'status: draft',
			'---',
			'Body.',
		].join('\n');
		expect(writeSummaryKeys(raw, desired)).toBe(
			[
				'---',
				'title: "Reading guide"',
				'document: "rg"',
				"date: '2026-10-26'",
				'answers: []',
				'annoteca_open: 2',
				'annoteca_oldest_open: 2026-10-26',
				'annoteca_categories:',
				'  - clarify',
				'  - decision-needed',
				'status: draft',
				'---',
				'Body.',
			].join('\n'),
		);
	});

	it('removes a key the summary no longer has, with its list items', () => {
		const raw =
			'---\na: 1\nannoteca_open: 3\nannoteca_categories:\n- tone\n- x\nb: 2\n---\n';
		expect(writeSummaryKeys(raw, { open: 0 })).toBe(
			'---\na: 1\nannoteca_open: 0\nb: 2\n---\n',
		);
	});

	it('adds the keys at the end of the block, and a block to a note with none', () => {
		expect(writeSummaryKeys('---\na: 1\n---\nx', { open: 1 })).toBe(
			'---\na: 1\nannoteca_open: 1\n---\nx',
		);
		expect(writeSummaryKeys('x', { open: 1 })).toBe(
			'---\nannoteca_open: 1\n---\nx',
		);
	});

	it('keeps Windows line endings', () => {
		const raw = '---\r\na: "1"\r\n---\r\nx';
		expect(writeSummaryKeys(raw, { open: 1 })).toBe(
			'---\r\na: "1"\r\nannoteca_open: 1\r\n---\r\nx',
		);
	});

	it('quotes a category YAML would read as something else', () => {
		const out = writeSummaryKeys('---\n---\n', {
			open: 1,
			categories: ['123', 'yes', 'ok'],
		});
		expect(out).toContain('  - "123"\n  - "yes"\n  - ok');
	});
});

describe('writeSummaryKeys, at the edges', () => {
	it('replaces a quoted summary key rather than adding a second one', () => {
		const out = writeSummaryKeys('---\n"annoteca_open": 5\n---\n', {
			open: 1,
		});
		expect(out).toBe('---\nannoteca_open: 1\n---\n');
	});

	it('removes a block value with blank lines in it whole', () => {
		const raw =
			'---\nannoteca_categories: |\n  first\n\n  second\ntitle: ok\n---\n';
		expect(writeSummaryKeys(raw, { open: 1 })).toBe(
			'---\nannoteca_open: 1\ntitle: ok\n---\n',
		);
	});

	it('refuses properties with no closing ---', () => {
		expect(() =>
			writeSummaryKeys('---\ntitle: x\nBody', { open: 1 }),
		).toThrow();
	});
});

describe('writeSummaryKeys, comments and flow values', () => {
	it('removes a list with a comment line among its items', () => {
		const raw = '---\nannoteca_categories:\n- a\n# c\n- b\ntitle: x\n---\n';
		expect(writeSummaryKeys(raw, { open: 1 })).toBe(
			'---\nannoteca_open: 1\ntitle: x\n---\n',
		);
	});

	it('removes a flow list that runs over lines', () => {
		const raw = '---\nannoteca_categories: [a,\nb]\ntitle: x\n---\n';
		expect(writeSummaryKeys(raw, { open: 1 })).toBe(
			'---\nannoteca_open: 1\ntitle: x\n---\n',
		);
	});
});

describe('writeSummaryKeys never takes a key that is not its own', () => {
	it.each([
		['a quote inside a flow item', "annoteca_categories: [it's, x]"],
		['a bracket in a plain value', 'annoteca_oldest_open: a[b'],
	])('with %s', (_, line) => {
		const raw = `---\n${line}\ntitle: x\nauthor: y\n---\n`;
		const out = writeSummaryKeys(raw, { open: 1 });
		expect(out).toContain('title: x\nauthor: y');
		expect(out).not.toContain(line);
	});
});

describe('the class tag', () => {
	it('is decided from the file, not a cache that lags it', async () => {
		let merged = 0;
		const app = {
			// The cache has not seen the tag the file already holds.
			metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
			vault: {
				process: (_f: TFile, fn: (data: string) => string) =>
					Promise.resolve(fn('---\nfileclass: annoteca\n---\n')),
			},
			fileManager: {
				processFrontMatter: () => {
					merged += 1;
					return Promise.resolve();
				},
			},
		} as unknown as App;
		await applyFrontmatterSummary(
			app,
			new TFile(),
			[mk({ date: '2026-10-01', category: 'tone' })],
			OPTS,
			undefined,
			() => Promise.resolve({ fileclass: 'annoteca' }),
		);
		expect(merged).toBe(0);
	});
});
