import { effectiveScopeState, rekeyScopeAnchor } from '../scope';
import type { ScopeState } from '../types';

const fileScope = (anchorPath: string, pinned = false): ScopeState => ({
	shape: { kind: 'file' },
	anchorPath,
	pinned,
});

// An unpinned "This file" scope follows the open note even when the stored
// anchor went stale, which left the hub on "No comments match this scope".
describe('effectiveScopeState', () => {
	it('resolves an unpinned file scope to the active note', () => {
		const s = effectiveScopeState(fileScope('old/note.md'), 'new/note.md');
		expect(s.anchorPath).toBe('new/note.md');
	});

	it('keeps a pinned file scope on its own note', () => {
		const s = effectiveScopeState(fileScope('a.md', true), 'b.md');
		expect(s.anchorPath).toBe('a.md');
	});

	it('leaves folder scopes alone', () => {
		const folder: ScopeState = {
			shape: { kind: 'folder', subfolders: true },
			anchorPath: 'Projects',
			pinned: false,
		};
		expect(effectiveScopeState(folder, 'Elsewhere/x.md')).toBe(folder);
	});

	it('keeps the stored anchor when no note is open', () => {
		const s = fileScope('a.md');
		expect(effectiveScopeState(s, undefined)).toBe(s);
	});
});

describe('rekeyScopeAnchor', () => {
	it('follows a renamed note', () => {
		expect(
			rekeyScopeAnchor(
				'1. Projects/a.md',
				'1. Projects/a.md',
				'1. Projects/b.md',
			),
		).toBe('1. Projects/b.md');
	});

	it('follows a renamed folder that contains the anchor', () => {
		expect(
			rekeyScopeAnchor(
				'1. Projects/sub/a.md',
				'1. Projects',
				'2. Archive',
			),
		).toBe('2. Archive/sub/a.md');
	});

	it('ignores a rename of a sibling that only shares a prefix', () => {
		expect(
			rekeyScopeAnchor('1. Projects/a.md', '1. Proj', '9. Other'),
		).toBeUndefined();
		expect(
			rekeyScopeAnchor('1. Projects/a.md', '1. Projects/a', 'x'),
		).toBeUndefined();
	});

	it('ignores an empty anchor (vault or root scopes)', () => {
		expect(rekeyScopeAnchor('', 'a.md', 'b.md')).toBeUndefined();
	});
});
