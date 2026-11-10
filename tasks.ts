// Task marks on a comment thread: a person marks one message (the comment or a
// reply) as a task, an agent plans it, a person approves it, the agent does it.
// Pure functions over a Comment; the write path is comment-service.ts. No
// Obsidian dependency.

import type { Comment, Reply, TaskMark, TaskState } from './types';
import { ROOT_TASK_AUTHOR } from './types';
import { sanitizeAuthorToken } from './parser';

// One message in a thread, named the way a task line names it.
export interface TaskTarget {
	author: string;
	date: string;
}

// The root comment as a task target. Its date is only the time it was marked.
export function rootTarget(date: string): TaskTarget {
	return { author: ROOT_TASK_AUTHOR, date };
}

// Authors compared as their line writes them: an end-of-file store keeps a
// reply's author as typed, while its task line holds the token form.
function sameTarget(a: TaskTarget, b: TaskTarget): boolean {
	if (a.author === ROOT_TASK_AUTHOR || b.author === ROOT_TASK_AUTHOR)
		return a.author === b.author;
	return (
		sanitizeAuthorToken(a.author) === sanitizeAuthorToken(b.author) &&
		a.date === b.date
	);
}

// The live task: the last one marked. Only it is ever acted on.
export function liveTask(c: Comment): TaskMark | undefined {
	const tasks = c.tasks ?? [];
	return tasks[tasks.length - 1];
}

// The mark on one message, if it has one.
export function taskFor(c: Comment, target: TaskTarget): TaskMark | undefined {
	return c.tasks?.find((t) => sameTarget(t, target));
}

// Whether author + date names more than one reply, so a mark could not say
// which one it means.
export function isAmbiguousReply(c: Comment, target: TaskTarget): boolean {
	return (
		target.author !== ROOT_TASK_AUTHOR &&
		c.replies.filter((r) => sameTarget(r, target)).length > 1
	);
}

const UNFINISHED: readonly TaskState[] = ['open', 'planned', 'approved'];

// The thread with `target` marked as a new open task. An unfinished earlier
// task is replaced, so only the newest is live. Marking a message again starts
// its task over and moves it to the end.
export function withTaskMarked(c: Comment, target: TaskTarget): Comment {
	const earlier = (c.tasks ?? [])
		.filter((t) => !sameTarget(t, target))
		.map((t) =>
			UNFINISHED.includes(t.state)
				? { ...t, state: 'replaced' as const }
				: t,
		);
	return {
		...c,
		tasks: [
			...earlier,
			{ author: target.author, date: target.date, state: 'open' },
		],
	};
}

// The thread with the live task approved, or undefined when there is no task
// waiting on approval (none, or not yet planned, or already past it).
export function withLiveTaskApproved(c: Comment): Comment | undefined {
	const live = liveTask(c);
	if (live?.state !== 'planned') return undefined;
	const tasks = (c.tasks ?? []).slice(0, -1);
	return { ...c, tasks: [...tasks, { ...live, state: 'approved' }] };
}

// The trigger word a reply starts with, if any. Matched on the first word,
// ignoring case, so "/go but put Snap on W" approves with an extra instruction.
export function triggerWordOf(
	body: string,
	words: readonly string[],
): string | undefined {
	const first = body.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
	if (first === '') return undefined;
	return words.find((w) => w.toLowerCase() === first);
}

// One second later than an ISO stamp, in the same local form nowISO writes, so
// a reply marked as a task does not share its author + date with another.
export function nextSecond(stamp: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
	if (!m) return stamp;
	const d = new Date(
		Number(m[1]),
		Number(m[2]) - 1,
		Number(m[3]),
		Number(m[4]),
		Number(m[5]),
		Number(m[6]) + 1,
	);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// A reply's stamp moved past any reply by the same author at the same second.
// Authors compared as tokens, never through the root-comment rule: a reply can
// carry the author `@comment` from a hand edit, and that rule ignores dates.
// Bounded so a malformed thread can never spin.
export function uniqueReplyDate(c: Comment, reply: Reply): string {
	const me = sanitizeAuthorToken(reply.author);
	let date = reply.date;
	for (let i = 0; i < 3600; i++) {
		if (
			!c.replies.some(
				(r) => sanitizeAuthorToken(r.author) === me && r.date === date,
			)
		)
			break;
		const next = nextSecond(date);
		if (next === date) break;
		date = next;
	}
	return date;
}
