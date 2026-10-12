/**
 * @jest-environment jsdom
 */
import type { App } from 'obsidian';

import {
	CommentEventTracker,
	debounceWithMaxWait,
	type CommentEvent,
} from '../comment-events';
import {
	EVENT_JOURNAL_MAX_CHARS,
	EventJournal,
	formatJournalLines,
} from '../event-journal';
import { CommentIndex } from '../index';
import { parseAll } from '../parser';

// A real marker, parsed by the real parser, so these test the comments the
// index actually holds rather than hand-built objects.
function marker(id: string, extra: string[] = []): string {
	return [
		`Some prose. <!-- annoteca/clarify: what does this mean`,
		`[id=${id}]`,
		'[date=2026-10-01]',
		'[author=ed]',
		...extra,
		'--> the passage.',
	].join('\n');
}

function comments(...markers: string[]) {
	return parseAll(markers.join('\n\n'));
}

function armed(): CommentEventTracker {
	const t = new CommentEventTracker();
	t.arm();
	return t;
}

describe('CommentEventTracker', () => {
	it('reports nothing for notes first seen before the vault scan', () => {
		const t = new CommentEventTracker();
		t.changed('a.md', comments(marker('aaaa1111')));
		t.arm();
		expect(t.hasPending).toBe(false);
		expect(t.flush()).toEqual([]);
	});

	it('reports created for a note that arrives after the scan', () => {
		const t = armed();
		t.changed('a.md', comments(marker('aaaa1111')));
		expect(t.flush()).toEqual([
			{
				type: 'created',
				id: 'aaaa1111',
				path: 'a.md',
				category: 'clarify',
				author: 'ed',
				date: '2026-10-01',
			},
		]);
	});

	it('folds changes made before arming into the baseline unreported', () => {
		const t = new CommentEventTracker();
		t.changed('a.md', comments(marker('aaaa1111')));
		t.changed('a.md', comments(marker('aaaa1111'), marker('bbbb2222')));
		t.arm();
		expect(t.hasPending).toBe(false);
		t.changed('a.md', comments(marker('aaaa1111')));
		expect(t.flush().map((e) => [e.type, e.id])).toEqual([
			['deleted', 'bbbb2222'],
		]);
	});

	it('reports one replied per new reply, with the reply author and date', () => {
		const t = armed();
		t.changed('a.md', comments(marker('aaaa1111')));
		t.flush();
		t.changed(
			'a.md',
			comments(
				marker('aaaa1111', [
					'[reply ai 2026-10-02]: here is an answer',
					'[reply ed 2026-10-03]: thanks',
				]),
			),
		);
		expect(t.flush()).toEqual([
			{
				type: 'replied',
				id: 'aaaa1111',
				path: 'a.md',
				category: 'clarify',
				author: 'ai',
				date: '2026-10-02',
			},
			{
				type: 'replied',
				id: 'aaaa1111',
				path: 'a.md',
				category: 'clarify',
				author: 'ed',
				date: '2026-10-03',
			},
		]);
	});

	it('reports addressed, resolved and reopened with their actors', () => {
		const t = armed();
		t.changed('a.md', comments(marker('aaaa1111')));
		t.flush();
		t.changed(
			'a.md',
			comments(
				marker('aaaa1111', [
					'[addressed ai 2026-10-02]: rewrote it',
					'[resolved ed 2026-10-03]: good',
				]),
			),
		);
		expect(t.flush().map((e) => [e.type, e.author, e.date])).toEqual([
			['addressed', 'ai', '2026-10-02'],
			['resolved', 'ed', '2026-10-03'],
		]);
		t.changed('a.md', comments(marker('aaaa1111')));
		expect(t.flush()).toEqual([
			{
				type: 'reopened',
				id: 'aaaa1111',
				path: 'a.md',
				category: 'clarify',
			},
		]);
	});

	it('reports deleted for a removed comment and for a deleted note', () => {
		const t = armed();
		t.changed('a.md', comments(marker('aaaa1111'), marker('bbbb2222')));
		t.flush();
		t.changed('a.md', comments(marker('aaaa1111')));
		expect(t.flush().map((e) => [e.type, e.id, e.path])).toEqual([
			['deleted', 'bbbb2222', 'a.md'],
		]);
		t.removed('a.md');
		expect(t.flush().map((e) => [e.type, e.id, e.path])).toEqual([
			['deleted', 'aaaa1111', 'a.md'],
		]);
		// Forgotten: the same path coming back is a new note.
		t.changed('a.md', comments(marker('aaaa1111')));
		expect(t.flush().map((e) => e.type)).toEqual(['created']);
	});

	it('reports moved per comment for a renamed note', () => {
		const t = armed();
		t.changed('a.md', comments(marker('aaaa1111'), marker('bbbb2222')));
		t.flush();
		t.renamed('a.md', 'b.md');
		expect(t.flush().map((e) => [e.type, e.id, e.path, e.oldPath])).toEqual(
			[
				['moved', 'aaaa1111', 'b.md', 'a.md'],
				['moved', 'bbbb2222', 'b.md', 'a.md'],
			],
		);
		t.changed('b.md', comments(marker('aaaa1111')));
		expect(t.flush().map((e) => [e.type, e.id, e.path])).toEqual([
			['deleted', 'bbbb2222', 'b.md'],
		]);
	});

	it('reports moved for a comment cut from one note and pasted in another', () => {
		const t = armed();
		t.changed('a.md', comments(marker('aaaa1111')));
		t.changed('b.md', comments());
		t.flush();
		t.changed('a.md', comments());
		t.changed(
			'b.md',
			comments(marker('aaaa1111', ['[reply ai 2026-10-02]: moved it'])),
		);
		expect(t.flush().map((e) => [e.type, e.path, e.oldPath])).toEqual([
			['moved', 'b.md', 'a.md'],
			['replied', 'b.md', undefined],
		]);
	});

	// The reason the owner flushes after things settle: a stale read in the
	// middle must not turn one creation into created, deleted, created.
	it('reports only where a burst settled, not each step', () => {
		const t = armed();
		t.changed('a.md', comments());
		t.flush();
		t.changed('a.md', comments(marker('aaaa1111')));
		t.changed('a.md', comments());
		t.changed('a.md', comments(marker('aaaa1111')));
		expect(t.flush().map((e) => e.type)).toEqual(['created']);
		t.changed('a.md', comments(marker('aaaa1111')));
		expect(t.flush()).toEqual([]);
	});

	it('carries the source of a promoted comment', () => {
		const t = armed();
		t.changed(
			'a.md',
			comments(marker('aaaa1111', ['[source=plumbline:a1b2c3d4]'])),
		);
		expect(t.flush()[0]?.source).toEqual({
			tag: 'plumbline',
			key: 'a1b2c3d4',
		});
	});

	it('ignores comments with no id', () => {
		const t = armed();
		t.changed(
			'a.md',
			parseAll('Prose. <!-- annoteca/clarify: no id here --> text.'),
		);
		expect(t.flush()).toEqual([]);
	});

	it('sees every rebuild through the index observer', () => {
		const t = armed();
		const index = new CommentIndex();
		index.observer = {
			changed: (p, c) => t.changed(p, c),
			removed: (p) => t.removed(p),
			renamed: (a, b) => t.renamed(a, b),
		};
		index.rebuild('a.md', marker('aaaa1111'));
		index.rename('a.md', 'b.md');
		expect(t.flush().map((e) => [e.type, e.path])).toEqual([
			['created', 'b.md'],
		]);
		index.remove('b.md');
		// Removing a path the index never had tells nobody.
		index.remove('nothing.md');
		expect(t.flush().map((e) => [e.type, e.path])).toEqual([
			['deleted', 'b.md'],
		]);
	});
});

describe('debounceWithMaxWait', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('runs once after things go quiet', () => {
		let runs = 0;
		const d = debounceWithMaxWait(
			() => (runs += 1),
			100,
			1000,
			() => jest.now(),
		);
		d.trigger();
		jest.advanceTimersByTime(50);
		d.trigger();
		jest.advanceTimersByTime(99);
		expect(runs).toBe(0);
		jest.advanceTimersByTime(1);
		expect(runs).toBe(1);
	});

	it('runs by the max wait under constant activity', () => {
		let runs = 0;
		const d = debounceWithMaxWait(
			() => (runs += 1),
			100,
			300,
			() => jest.now(),
		);
		for (let i = 0; i < 10; i++) {
			d.trigger();
			jest.advanceTimersByTime(50);
		}
		expect(runs).toBeGreaterThanOrEqual(1);
	});

	it('cancel drops the pending run', () => {
		let runs = 0;
		const d = debounceWithMaxWait(
			() => (runs += 1),
			100,
			1000,
			() => jest.now(),
		);
		d.trigger();
		d.cancel();
		jest.advanceTimersByTime(2000);
		expect(runs).toBe(0);
	});
});

// An in-memory vault adapter with just the calls EventJournal makes.
function makeAdapter() {
	const files = new Map<string, string>();
	return {
		files,
		exists: (p: string) => Promise.resolve(files.has(p)),
		stat: (p: string) =>
			Promise.resolve(
				files.has(p) ? { size: files.get(p)?.length ?? 0 } : null,
			),
		append: (p: string, data: string) => {
			files.set(p, (files.get(p) ?? '') + data);
			return Promise.resolve();
		},
		remove: (p: string) => {
			files.delete(p);
			return Promise.resolve();
		},
		rename: (from: string, to: string) => {
			files.set(to, files.get(from) ?? '');
			files.delete(from);
			return Promise.resolve();
		},
	};
}

const EV: CommentEvent = {
	type: 'created',
	id: 'aaaa1111',
	path: 'a.md',
	category: 'clarify',
};

describe('EventJournal', () => {
	function journal(enabled: boolean) {
		const adapter = makeAdapter();
		const app = { vault: { adapter } } as unknown as App;
		const j = new EventJournal(
			app,
			'config/plugins/annoteca',
			() => enabled,
		);
		return { j, adapter };
	}

	it('writes one JSON line per event with a timestamp', () => {
		const at = new Date('2026-10-12T10:00:00Z');
		const text = formatJournalLines(
			[EV, { type: 'resync', reason: 'scan' }],
			at,
		);
		const lines = text.trimEnd().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? '')).toEqual({
			at: '2026-10-12T10:00:00.000Z',
			...EV,
		});
		expect(text.endsWith('\n')).toBe(true);
	});

	it('appends to events.jsonl in the plugin folder', async () => {
		const { j, adapter } = journal(true);
		j.write([EV]);
		j.write([{ ...EV, type: 'deleted' }]);
		await j.flushed();
		const text = adapter.files.get('config/plugins/annoteca/events.jsonl');
		expect(text?.trimEnd().split('\n')).toHaveLength(2);
	});

	it('writes nothing while off', async () => {
		const { j, adapter } = journal(false);
		j.write([EV]);
		await j.flushed();
		expect(adapter.files.size).toBe(0);
	});

	// A name-following tail picks up a fresh file; a file trimmed in place
	// would replay old lines to it.
	it('rotates past the cap by renaming, never rewriting', async () => {
		const { j, adapter } = journal(true);
		adapter.files.set(j.path, 'x'.repeat(EVENT_JOURNAL_MAX_CHARS));
		adapter.files.set(j.rotatedPath, 'older');
		j.write([EV]);
		await j.flushed();
		expect(adapter.files.has(j.path)).toBe(false);
		expect(adapter.files.get(j.rotatedPath)?.startsWith('xxx')).toBe(true);
		j.write([EV]);
		await j.flushed();
		expect(adapter.files.get(j.path)?.trimEnd().split('\n')).toHaveLength(
			1,
		);
	});
});
