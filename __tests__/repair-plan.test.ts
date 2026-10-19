// What the repair commands say before and while they run: which notes need
// the repair, which of them are slow, and the wording around them.

import { repairNestedMarkers, SLOW_REPAIR_PIECES } from '../nested-repair';
import { serialize } from '../parser';
import {
	repairConfirmText,
	repairProgressText,
	repairTarget,
	type RepairTarget,
} from '../repair-plan';

const marker = (id: string, body: string): string =>
	serialize({ id, body, category: 'note', date: '2026-10-01' });
const id = (p: string, i: number): string =>
	`${p}${String(i).padStart(7, '0')}`;

// `n` comments each written into another one on the same line: the shape
// whose repair grows with the square of their number.
function packed(n: number): string {
	let line = '';
	for (let i = 0; i < n; i++)
		line += `word ${marker(id('a', i), 'X').replace('X', 'ho' + marker(id('b', i), 'new') + 'st')} more `;
	return `Intro.\n\n${line}\nAfter.\n`;
}

const target = (name: string, slow = false): RepairTarget => ({
	path: `${name}.md`,
	name,
	slow,
});

describe('repairTarget', () => {
	it('skips a note the repair would not change', () => {
		const note = `Intro ${marker('aaaaaaaa', 'fine')} text.\n`;
		expect(repairTarget('a.md', 'a', note)).toBeUndefined();
	});

	it('names a damaged note, quick to repair when lightly damaged', () => {
		const note = packed(3);
		expect(repairNestedMarkers(note).converted).toBe(3);
		expect(repairTarget('a.md', 'a', note)).toEqual({
			path: 'a.md',
			name: 'a',
			slow: false,
		});
	});

	it('marks a note slow from the number of comments packed into it', () => {
		expect(
			repairTarget('a.md', 'a', packed(SLOW_REPAIR_PIECES - 1))?.slow,
		).toBe(false);
		expect(
			repairTarget('a.md', 'a', packed(SLOW_REPAIR_PIECES))?.slow,
		).toBe(true);
	});
});

describe('repair wording', () => {
	it('lists the notes and says which may take a while', () => {
		const { description, items } = repairConfirmText([
			target('Draft'),
			target('Meeting notes', true),
		]);
		expect(description).toMatch(/2 notes need it:$/);
		expect(items).toEqual([
			'Draft',
			'Meeting notes: many damaged comments, may take a few seconds',
		]);
	});

	it('says one note in the singular', () => {
		expect(repairConfirmText([target('Draft')]).description).toMatch(
			/1 note needs it:$/,
		);
	});

	it('lists twenty notes and counts the rest', () => {
		const many = Array.from({ length: 23 }, (_, i) => target(`n${i}`));
		const { items } = repairConfirmText(many);
		expect(items).toHaveLength(21);
		expect(items[19]).toBe('n19');
		expect(items[20]).toBe('and 3 more');
	});

	it('shows which note a run is on, and warns on a slow one', () => {
		expect(repairProgressText(2, 5, target('Draft'))).toBe(
			'Repairing comments: note 2 of 5, Draft.',
		);
		expect(repairProgressText(3, 5, target('Big', true))).toBe(
			'Repairing comments: note 3 of 5, Big. It has many damaged comments, so this may take a few seconds.',
		);
	});
});
