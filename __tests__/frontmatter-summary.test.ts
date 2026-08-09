import type { Comment } from '../types';
import {
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
