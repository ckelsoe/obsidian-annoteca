/**
 * @jest-environment jsdom
 */
// Anchoring hardening, part B: noticing a comment that disappeared.

import { LossGuard, type LostComment } from '../loss-guard';
import { parseAll } from '../parser';
import type { Comment } from '../types';

const marker = (id: string) =>
	`<!-- annoteca/tone: about ${id}\n[id=${id}]\n--> text.`;
const comments = (...ids: string[]): Comment[] =>
	parseAll(ids.map(marker).join('\n\n'));

function rig(located: Set<string> = new Set(), exists = true) {
	const reports: LostComment[][] = [];
	const guard = new LossGuard({
		exists: () => exists,
		located: (id) => located.has(id),
		report: (b) => reports.push([...b]),
		graceMs: 1000,
	});
	return { guard, reports };
}

describe('LossGuard', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('reports a comment that vanished from a note it had seen', () => {
		const { guard, reports } = rig();
		guard.changed('a.md', comments('aaaa1111', 'bbbb2222'));
		guard.changed('a.md', comments('bbbb2222'));
		expect(reports).toHaveLength(0);
		jest.advanceTimersByTime(1000);
		expect(reports.map((b) => b.map((l) => l.id))).toEqual([['aaaa1111']]);
		expect(guard.lost.map((l) => l.id)).toEqual(['aaaa1111']);
	});

	it('does not report a comment Annoteca removed on purpose', () => {
		const { guard, reports } = rig();
		guard.changed('a.md', comments('aaaa1111'));
		guard.expectRemoval('aaaa1111');
		guard.changed('a.md', []);
		jest.advanceTimersByTime(1000);
		expect(reports).toHaveLength(0);
	});

	it('does not report one that came back, or moved, within the grace period', () => {
		const located = new Set<string>();
		const { guard, reports } = rig(located);
		guard.changed('a.md', comments('aaaa1111'));
		guard.changed('a.md', []);
		located.add('aaaa1111');
		jest.advanceTimersByTime(1000);
		expect(reports).toHaveLength(0);
	});

	it('does not report the comments of a deleted note', () => {
		const { guard, reports } = rig(new Set(), false);
		guard.changed('a.md', comments('aaaa1111'));
		guard.changed('a.md', []);
		jest.advanceTimersByTime(1000);
		expect(reports).toHaveLength(0);
		const second = rig();
		second.guard.changed('b.md', comments('bbbb2222'));
		second.guard.removed('b.md');
		jest.advanceTimersByTime(1000);
		expect(second.reports).toHaveLength(0);
	});

	it('ignores the first sighting of a note', () => {
		const { guard, reports } = rig();
		guard.changed('a.md', []);
		jest.advanceTimersByTime(1000);
		expect(reports).toHaveLength(0);
	});

	it('reports several losses as one batch, and forgets one put back', () => {
		const { guard, reports } = rig();
		guard.changed('a.md', comments('aaaa1111', 'bbbb2222'));
		guard.changed('a.md', []);
		jest.advanceTimersByTime(1000);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toHaveLength(2);
		guard.forget('aaaa1111');
		expect(guard.lost.map((l) => l.id)).toEqual(['bbbb2222']);
	});

	it('follows a renamed note', () => {
		const { guard, reports } = rig();
		guard.changed('a.md', comments('aaaa1111'));
		guard.renamed('a.md', 'b.md');
		guard.changed('b.md', []);
		jest.advanceTimersByTime(1000);
		expect(reports[0]?.[0]?.path).toBe('b.md');
	});
});
