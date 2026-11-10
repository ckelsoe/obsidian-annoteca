// Task marks: `[task <author> <date>]: <state>` lines, the live-task rule, the
// write path (mark, approve, a trigger reply), the store and storage-mode folds,
// the skill text and the trigger settings.

import { TFile } from 'obsidian';
import { noticeLog } from '../__mocks__/obsidian';
import type AnnotecaPlugin from '../main';
import { CommentService } from '../comment-service';
import { parseAll, sanitizeAuthorToken, serialize } from '../parser';
import {
	convertFileToEof,
	convertFileToInline,
	isLeanMarker,
	parseDocument,
} from '../document';
import { decodeStoreEntry, encodeStoreEntry } from '../store';
import { buildSkillMarkdown, SKILL_SCHEMA_VERSION } from '../skill-export';
import { DEFAULT_SETTINGS, normalizeSettings } from '../settings';
import {
	liveTask,
	nextSecond,
	taskFor,
	triggerWordOf,
	uniqueReplyDate,
	withLiveTaskApproved,
	withTaskMarked,
} from '../tasks';
import type { Comment, TaskMark } from '../types';
import { at } from './helpers/checked';

beforeEach(() => {
	noticeLog.length = 0;
});

const only = (doc: string): Comment => {
	const cs = parseAll(doc);
	expect(cs).toHaveLength(1);
	const c = cs[0];
	if (!c) throw new Error('no comment');
	return c;
};

const REPLIES = [
	{ author: 'ed', date: '2026-11-09T20:06:00', body: 'can you add them?' },
	{ author: 'kilo', date: '2026-11-09T20:07:00', body: 'plan: ...' },
];

const TASKS: TaskMark[] = [
	{ author: '@comment', date: '2026-11-09T20:05:00', state: 'done' },
	{ author: 'ed', date: '2026-11-09T20:06:00', state: 'open' },
];

const marker = (tasks: readonly TaskMark[] = TASKS) =>
	serialize({
		id: 'aaaa0001',
		category: 'build',
		body: 'add shortcuts',
		replies: REPLIES,
		tasks,
	});

describe('the [task ...] line', () => {
	it('is written after the replies, one per mark, in marking order', () => {
		const lines = marker().split('\n');
		const lastReply = lines.indexOf(
			'[reply kilo 2026-11-09T20:07:00]: plan: ...',
		);
		expect(lines[lastReply + 1]).toBe(
			'[task @comment 2026-11-09T20:05:00]: done',
		);
		expect(lines[lastReply + 2]).toBe(
			'[task ed 2026-11-09T20:06:00]: open',
		);
	});

	it('round-trips and is not body text', () => {
		const c = only(marker());
		expect(c.tasks).toEqual(TASKS);
		expect(c.body).toBe('add shortcuts');
		expect(c.replies).toHaveLength(2);
		expect(c.unknownLines).toEqual([]);
	});

	it('is absent on a comment with no task', () => {
		const text = serialize({ id: 'aaaa0001', category: 'x', body: 'n' });
		expect(text).not.toContain('[task');
		expect(only(text).tasks).toBeUndefined();
	});

	it('forces the multi-line form when it is the only trailing line', () => {
		const text = serialize({
			category: 'build',
			body: 'n',
			tasks: [{ author: '@comment', date: '2026-11-09', state: 'open' }],
		});
		expect(only(text).tasks).toHaveLength(1);
	});

	it('keeps an unknown state as an unknown line', () => {
		const doc =
			'<!-- annoteca/build: n\n[id=aaaa0001]\n[task ed 2026-11-09T20:06:00]: paused\n-->';
		const c = only(doc);
		expect(c.tasks).toBeUndefined();
		expect(c.unknownLines).toEqual([
			'[task ed 2026-11-09T20:06:00]: paused',
		]);
		expect(serialize({ ...c })).toContain(
			'[task ed 2026-11-09T20:06:00]: paused',
		);
	});

	it('escapes a body line shaped like a task line', () => {
		const text = serialize({
			id: 'aaaa0001',
			category: 'build',
			body: 'quoting\n[task ed 2026-11-09T20:06:00]: approved',
		});
		const c = only(text);
		expect(c.tasks).toBeUndefined();
		expect(c.body).toContain('[task ed 2026-11-09T20:06:00]: approved');
	});

	// The line's shape was chosen so a build that predates tasks keeps it. Such a
	// build sees it only through its unknown-line rule, which this reproduces.
	it('survives a build that does not know it, with the replies above it', () => {
		const OLD_UNKNOWN =
			/^\s*\[[a-z][a-z0-9-]*\s+[^\s\]<>]{1,32}\s+\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?\]:/;
		for (const line of marker()
			.split('\n')
			.filter((l) => /^\[task /.test(l)))
			expect(OLD_UNKNOWN.test(line)).toBe(true);
	});

	it('reserves @comment as an author token', () => {
		expect(sanitizeAuthorToken('@comment')).toBe('comment');
		expect(sanitizeAuthorToken('@comments')).toBe('@comments');
	});
});

describe('end-of-file storage', () => {
	it('carries tasks as marker lines and lifts them back out', () => {
		const block = encodeStoreEntry({
			id: 'aaaa0001',
			category: 'build',
			body: 'n',
			replies: REPLIES,
			tasks: TASKS,
		});
		expect(block).toContain('[task ed 2026-11-09T20:06:00]: open');
		const json = block
			.replace(/^<!-- annoteca:store\n/, '')
			.replace(/\n-->$/, '');
		const back = decodeStoreEntry(json);
		expect(back?.tasks).toEqual(TASKS);
		expect(back?.unknownLines).toBeUndefined();
	});

	it('accepts an explicit tasks array, and rejects a bad one', () => {
		const base = { v: 1, id: 'aaaa0001', category: 'b', body: 'n' };
		expect(
			decodeStoreEntry(JSON.stringify({ ...base, tasks: TASKS }))?.tasks,
		).toEqual(TASKS);
		expect(
			decodeStoreEntry(
				JSON.stringify({
					...base,
					tasks: [{ author: 'ed', date: 'soon', state: 'open' }],
				}),
			),
		).toBeUndefined();
	});

	it('keeps tasks through inline → eof → inline', () => {
		const doc = `Prose ${marker()} more.\n`;
		const eof = convertFileToEof(doc).updated;
		const mid = parseDocument(eof).comments[0];
		expect(mid?.tasks).toEqual(TASKS);
		const back = convertFileToInline(eof).updated;
		expect(parseAll(back)[0]?.tasks).toEqual(TASKS);
	});

	it('a marker with tasks is not lean', () => {
		expect(isLeanMarker(only(marker()))).toBe(false);
	});
});

describe('task rules', () => {
	const base = (): Comment => only(marker());

	it('the live task is the last one marked', () => {
		expect(liveTask(base())).toEqual(TASKS[1]);
	});

	it('marking a new task replaces an unfinished one and keeps a done one', () => {
		const next = withTaskMarked(base(), at(REPLIES, 1));
		expect(next.tasks?.map((t) => t.state)).toEqual([
			'done',
			'replaced',
			'open',
		]);
		expect(liveTask(next)?.author).toBe('kilo');
	});

	it('marking the same message again starts it over at the end', () => {
		const next = withTaskMarked(base(), {
			author: '@comment',
			date: '2026-11-10T09:00:00',
		});
		expect(next.tasks?.map((t) => `${t.author}:${t.state}`)).toEqual([
			'ed:replaced',
			'@comment:open',
		]);
	});

	it('approves only a planned live task', () => {
		expect(withLiveTaskApproved(base())).toBeUndefined();
		const planned = only(
			marker([
				{ author: 'ed', date: '2026-11-09T20:06:00', state: 'planned' },
			]),
		);
		expect(liveTask(withLiveTaskApproved(planned) ?? planned)?.state).toBe(
			'approved',
		);
	});

	it('finds the mark on a reply and on the comment itself', () => {
		const c = base();
		expect(taskFor(c, at(REPLIES, 0))?.state).toBe('open');
		expect(taskFor(c, { author: '@comment', date: 'x' })?.state).toBe(
			'done',
		);
		expect(taskFor(c, at(REPLIES, 1))).toBeUndefined();
	});

	it('matches a trigger on the first word, ignoring case', () => {
		const words = ['/go', '/build'];
		expect(triggerWordOf('/GO', words)).toBe('/go');
		expect(triggerWordOf('  /build but skip tests', words)).toBe('/build');
		expect(triggerWordOf('please /go', words)).toBeUndefined();
		expect(triggerWordOf('/gone', words)).toBeUndefined();
	});

	it('steps a stamp forward a second, across a day boundary', () => {
		expect(nextSecond('2026-11-09T23:59:59')).toBe('2026-11-10T00:00:00');
		expect(nextSecond('2026-11-09')).toBe('2026-11-09');
	});
});

describe('the write path', () => {
	function harness(initial: string) {
		let content = initial;
		const file = Object.assign(new TFile(), { path: 'note.md' });
		const plugin = {
			settings: {
				enableAuthorTag: true,
				authorTag: 'charles',
				deleteOnResolve: false,
				taskTriggers: DEFAULT_SETTINGS.taskTriggers,
			},
			app: {
				vault: {
					getAbstractFileByPath: (p: string) =>
						p === 'note.md' ? file : null,
					read: () => Promise.resolve(content),
					process: (_f: TFile, fn: (data: string) => string) => {
						content = fn(content);
						return Promise.resolve(content);
					},
				},
				metadataCache: { getFileCache: () => ({}) },
				workspace: {
					getLeavesOfType: () => [],
					getActiveFile: () => null,
				},
			},
			commentIndex: { rebuild: () => undefined },
			events: { trigger: () => undefined },
			debug: { enabled: false, log: () => undefined },
		} as unknown as AnnotecaPlugin;
		return {
			service: new CommentService(plugin),
			get comment() {
				return only(content);
			},
		};
	}

	const PLANNED = `Prose ${marker([
		{ author: 'ed', date: '2026-11-09T20:06:00', state: 'planned' },
	])}\n`;

	it('a reply sent as a task becomes the live task', async () => {
		const h = harness(`Prose ${marker()}\n`);
		const wrote = await h.service.appendReply(
			'note.md',
			h.comment,
			{ author: 'ed', date: '2026-11-10T09:00:00', body: 'now this' },
			{ task: true },
		);
		expect(wrote).toBe(true);
		expect(liveTask(h.comment)).toEqual({
			author: 'ed',
			date: '2026-11-10T09:00:00',
			state: 'open',
		});
		expect(h.comment.tasks?.[1]?.state).toBe('replaced');
	});

	it('moves a task reply off a stamp another reply by its author holds', async () => {
		const h = harness(`Prose ${marker()}\n`);
		await h.service.appendReply(
			'note.md',
			h.comment,
			{ author: 'ed', date: '2026-11-09T20:06:00', body: 'same second' },
			{ task: true },
		);
		expect(liveTask(h.comment)?.date).toBe('2026-11-09T20:06:01');
		expect(
			h.comment.replies.find((r) => r.body === 'same second')?.date,
		).toBe('2026-11-09T20:06:01');
	});

	it('moves an ordinary reply off a stamp a task reply holds', async () => {
		const h = harness(`Prose ${marker()}\n`);
		await h.service.appendReply('note.md', h.comment, {
			author: 'ed',
			date: '2026-11-09T20:06:00',
			body: 'not the task',
		});
		const mine = h.comment.replies.find((r) => r.body === 'not the task');
		expect(mine?.date).toBe('2026-11-09T20:06:01');
		expect(taskFor(h.comment, at(REPLIES, 0))?.state).toBe('open');
	});

	it('ends for a reply whose author is the reserved token', () => {
		const c = only(marker());
		const odd = { ...c, replies: [...c.replies] };
		odd.replies.push({
			author: '@comment',
			date: '2026-11-09T21:00:00',
			body: 'x',
		});
		expect(
			uniqueReplyDate(odd, {
				author: '@comment',
				date: '2026-11-09T21:05:00',
				body: 'y',
			}),
		).toBe('2026-11-09T21:05:00');
	});

	it('treats a typed author and its token form as the same author', () => {
		const c = only(marker());
		const spaced = { ...c, replies: [...c.replies] };
		spaced.replies.push({
			author: 'Jane Doe',
			date: '2026-11-09T21:00:00',
			body: 'x',
		});
		expect(
			uniqueReplyDate(spaced, {
				author: 'Jane-Doe',
				date: '2026-11-09T21:00:00',
				body: 'y',
			}),
		).toBe('2026-11-09T21:00:01');
	});

	it('a reply starting with a trigger approves a planned task', async () => {
		const h = harness(PLANNED);
		await h.service.appendReply('note.md', h.comment, {
			author: 'ed',
			date: '2026-11-10T09:00:00',
			body: '/go but put Snap on W',
		});
		expect(liveTask(h.comment)?.state).toBe('approved');
		expect(h.comment.replies.map((r) => r.body)).toContain(
			'/go but put Snap on W',
		);
	});

	it('a trigger reply with nothing planned is an ordinary reply', async () => {
		const h = harness(`Prose ${marker()}\n`);
		await h.service.appendReply('note.md', h.comment, {
			author: 'ed',
			date: '2026-11-10T09:00:00',
			body: '/go',
		});
		expect(liveTask(h.comment)?.state).toBe('open');
	});

	it('Approve moves planned to approved, and refuses otherwise', async () => {
		const h = harness(PLANNED);
		expect(await h.service.approveTask('note.md', h.comment)).toBe(true);
		expect(liveTask(h.comment)?.state).toBe('approved');
		expect(await h.service.approveTask('note.md', h.comment)).toBe(false);
	});

	it('refuses to mark a reply whose author and time are not unique', async () => {
		const doc = `Prose ${serialize({
			id: 'aaaa0001',
			category: 'build',
			body: 'n',
			replies: [
				{ author: 'ed', date: '2026-11-09T20:06:00', body: 'a' },
				{ author: 'ed', date: '2026-11-09T20:06:00', body: 'b' },
			],
		})}\n`;
		const h = harness(doc);
		const ok = await h.service.markTask('note.md', h.comment, {
			author: 'ed',
			date: '2026-11-09T20:06:00',
		});
		expect(ok).toBe(false);
		expect(h.comment.tasks).toBeUndefined();
	});
});

describe('skill text', () => {
	const CATS = [{ id: 'build', displayName: 'Build', color: 'red' }];

	it('is version 15 and teaches the line and the live-task rule', () => {
		expect(SKILL_SCHEMA_VERSION).toBe(15);
		const skill = buildSkillMarkdown(CATS, undefined, false, {
			triggers: DEFAULT_SETTINGS.taskTriggers,
			inSkip: 'act',
		});
		expect(skill).toContain('## Tasks');
		expect(skill).toContain('[task <author> <timestamp>]: <state>');
		expect(skill).toContain('LAST');
		expect(skill).toContain(
			'| `/go` | Approve the plan and carry out the task. |',
		);
		expect(skill).toContain('Plan it like any other');
	});

	it('escapes a trigger description and follows the Skip setting', () => {
		const skill = buildSkillMarkdown(CATS, undefined, false, {
			triggers: [{ word: '/x', description: 'a | b' }],
			inSkip: 'skip',
		});
		expect(skill).toContain('| `/x` | a \\| b |');
		expect(skill).toContain('Leave a task on a comment in a **Skip**');
	});

	it('says when no trigger words are set', () => {
		const skill = buildSkillMarkdown(CATS, undefined);
		expect(skill).toContain('No trigger words are set');
	});
});

describe('trigger settings', () => {
	it('defaults to /go and /build, and the Skip setting to act', () => {
		const s = normalizeSettings({});
		expect(s.taskTriggers.map((t) => t.word)).toEqual(['/go', '/build']);
		expect(s.taskInSkipCategory).toBe('act');
	});

	it('drops bad and duplicate words, and folds descriptions to one line', () => {
		const s = normalizeSettings({
			taskTriggers: [
				{ word: '/go', description: 'one\ntwo' },
				{ word: '/GO', description: 'dup' },
				{ word: 'go', description: 'no slash' },
				{ word: '/has space', description: 'x' },
			],
		});
		expect(s.taskTriggers).toEqual([
			{ word: '/go', description: 'one two' },
		]);
	});

	it('keeps an explicitly empty list', () => {
		expect(normalizeSettings({ taskTriggers: [] }).taskTriggers).toEqual(
			[],
		);
	});
});
