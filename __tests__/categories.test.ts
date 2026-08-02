import {
	DEFAULT_CATEGORIES,
	SCHOLARLY_PRESET_CATEGORIES,
	RESERVED_CATEGORY_NAMES,
	isValidCategoryName,
	resolveEnabledCategories,
	getCategoryOrFallback,
	reorderCategories,
} from '../categories';
import type { CategoryDefinition } from '../types';

describe('categories: validation', () => {
	it('accepts valid category names', () => {
		expect(isValidCategoryName('tone')).toBe(true);
		expect(isValidCategoryName('source-needed')).toBe(true);
		expect(isValidCategoryName('verse-needed')).toBe(true);
		expect(isValidCategoryName('a1b2')).toBe(true);
	});

	it('rejects invalid name shapes', () => {
		expect(isValidCategoryName('')).toBe(false);
		expect(isValidCategoryName('Tone')).toBe(false);
		expect(isValidCategoryName('1abc')).toBe(false);
		expect(isValidCategoryName('trailing-')).toBe(false);
		expect(isValidCategoryName('double--dash')).toBe(false);
		expect(isValidCategoryName('space here')).toBe(false);
	});

	it('rejects reserved names', () => {
		for (const reserved of RESERVED_CATEGORY_NAMES) {
			expect(isValidCategoryName(reserved)).toBe(false);
		}
	});
});

describe('categories: defaults', () => {
	it('ships seven default categories', () => {
		expect(DEFAULT_CATEGORIES).toHaveLength(7);
	});

	it('ships an uncategorized scratchpad default', () => {
		expect(
			DEFAULT_CATEGORIES.find((c) => c.id === 'uncategorized'),
		).toBeDefined();
	});

	it('ships scholarly preset with verse-needed and meditation', () => {
		const ids = SCHOLARLY_PRESET_CATEGORIES.map((c) => c.id);
		expect(ids).toContain('verse-needed');
		expect(ids).toContain('meditation');
	});

	it('every default category passes validation', () => {
		for (const c of DEFAULT_CATEGORIES) {
			expect(isValidCategoryName(c.id)).toBe(true);
		}
		for (const c of SCHOLARLY_PRESET_CATEGORIES) {
			expect(isValidCategoryName(c.id)).toBe(true);
		}
	});
});

describe('categories: resolveEnabledCategories', () => {
	it('returns only the base list when the scholarly preset is off', () => {
		const result = resolveEnabledCategories(DEFAULT_CATEGORIES, false);
		expect(result).toHaveLength(DEFAULT_CATEGORIES.length);
	});

	it('includes scholarly categories when the preset is on', () => {
		const result = resolveEnabledCategories(DEFAULT_CATEGORIES, true);
		const ids = result.map((c) => c.id);
		expect(ids).toContain('verse-needed');
		expect(ids).toContain('meditation');
	});

	it('user-defined categories override defaults of the same id', () => {
		const custom = [
			{ id: 'tone', displayName: 'My tone', icon: 'smile', color: 'red' },
		];
		const result = resolveEnabledCategories(custom, false);
		const tone = result.find((c) => c.id === 'tone');
		expect(tone?.displayName).toBe('My tone');
	});
});

describe('categories: getCategoryOrFallback', () => {
	it('returns the found category', () => {
		const found = getCategoryOrFallback('tone', DEFAULT_CATEGORIES);
		expect(found.id).toBe('tone');
	});

	it('returns a stand-in when the id is unknown', () => {
		const fallback = getCategoryOrFallback('ghost', DEFAULT_CATEGORIES);
		expect(fallback.id).toBe('ghost');
		expect(fallback.displayName.toLowerCase()).toContain('ghost');
	});
});

describe('categories: reorderCategories', () => {
	const cat = (id: string): CategoryDefinition => ({ id, displayName: id });
	const ids = (list: readonly CategoryDefinition[]) => list.map((c) => c.id);
	const base = [cat('a'), cat('b'), cat('c'), cat('d')];

	it('moves a row down to the target slot, shifting the rest', () => {
		expect(ids(reorderCategories(base, 'a', 'c'))).toEqual([
			'b',
			'c',
			'a',
			'd',
		]);
	});

	it('moves a row up to the target slot, shifting the rest', () => {
		expect(ids(reorderCategories(base, 'd', 'b'))).toEqual([
			'a',
			'd',
			'b',
			'c',
		]);
	});

	it('moving onto the first slot puts the dragged item at the front', () => {
		expect(ids(reorderCategories(base, 'c', 'a'))).toEqual([
			'c',
			'a',
			'b',
			'd',
		]);
	});

	it('returns an unchanged copy when drag and target are the same', () => {
		const result = reorderCategories(base, 'b', 'b');
		expect(ids(result)).toEqual(['a', 'b', 'c', 'd']);
		expect(result).not.toBe(base);
	});

	it('returns an unchanged copy when an id is missing', () => {
		expect(ids(reorderCategories(base, 'a', 'ghost'))).toEqual([
			'a',
			'b',
			'c',
			'd',
		]);
		expect(ids(reorderCategories(base, 'ghost', 'a'))).toEqual([
			'a',
			'b',
			'c',
			'd',
		]);
	});

	it('does not mutate the input array', () => {
		reorderCategories(base, 'a', 'd');
		expect(ids(base)).toEqual(['a', 'b', 'c', 'd']);
	});
});
