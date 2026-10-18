// Per-comment change events (#95): what happened to which comment, for the
// API's onCommentEvent, the optional event journal and reply alerts.
//
// The index does not diff. `rebuild` replaces a note's whole comment list, so
// these events come from comparing a settled snapshot per note against the
// note's latest parse, keyed by comment id. Comments with no id are invisible
// here: there is nothing to follow them by.
//
// Settled, not per rebuild, because a single change can reach the index more
// than once with different content. A composer write rebuilds from the editor
// buffer while a leaf change can rebuild the same note from the last SAVED
// bytes, so for a moment the new comment is there, then gone, then back. Diffed
// per rebuild that is created, deleted, created, and a consumer that answers
// comments answers twice. The owner flushes after a quiet period instead (see
// debounceWithMaxWait), and the flush compares only where things settled.

import type { Comment, CommentSource } from './types';

type CommentEventType =
	| 'created'
	| 'replied'
	| 'addressed'
	| 'resolved'
	| 'reopened'
	| 'moved'
	| 'deleted'
	| 'resync';

export interface CommentEvent {
	readonly type: CommentEventType;
	// Absent only on resync.
	readonly id?: string;
	// The note the comment is in now. For deleted, the note it was in.
	readonly path?: string;
	// moved only: the note it was in before.
	readonly oldPath?: string;
	readonly category?: string;
	// Who did the thing this event reports, and when, as written in the note:
	// the comment's author for created, the reply's for replied, the
	// resolver's for resolved. Absent when the note does not say (reopened,
	// deleted, moved, or a comment written without an author tag).
	readonly author?: string;
	readonly date?: string;
	// Set for a comment another plugin created through promote().
	readonly source?: { readonly tag: string; readonly key: string };
	// resync only. 'scan': the vault has just been indexed and events start
	// here, so anything earlier must be read with queryComments.
	readonly reason?: 'scan' | 'journal-on';
}

interface Snapshot {
	category: string;
	author: string | undefined;
	date: string | undefined;
	source: CommentSource | undefined;
	replies: readonly { author: string; date: string }[];
	addressed: { author: string; date: string } | undefined;
	resolution: { author: string; date: string } | undefined;
}

type NoteSnapshot = Map<string, Snapshot>;

// Copies, never the index's own objects, so a later write that reuses one
// cannot change what this remembers as the previous state.
function snapshotNote(comments: readonly Comment[]): NoteSnapshot {
	const out: NoteSnapshot = new Map();
	for (const c of comments) {
		// First wins on a duplicated id, matching how the rest of the plugin
		// resolves one.
		if (c.id === undefined || out.has(c.id)) continue;
		out.set(c.id, {
			category: c.category,
			author: c.author,
			date: c.date,
			source: c.source && { tag: c.source.tag, key: c.source.key },
			replies: c.replies.map((r) => ({ author: r.author, date: r.date })),
			addressed: c.addressed && {
				author: c.addressed.author,
				date: c.addressed.date,
			},
			resolution: c.resolution && {
				author: c.resolution.author,
				date: c.resolution.date,
			},
		});
	}
	return out;
}

function base(
	type: CommentEventType,
	id: string,
	path: string,
	s: Snapshot,
): {
	type: CommentEventType;
	id: string;
	path: string;
	category: string;
	source?: { tag: string; key: string };
} {
	return {
		type,
		id,
		path,
		category: s.category,
		...(s.source && { source: { tag: s.source.tag, key: s.source.key } }),
	};
}

function actor(
	author: string | undefined,
	date: string | undefined,
): { author?: string; date?: string } {
	return {
		...(author !== undefined && author !== '' && { author }),
		...(date !== undefined && date !== '' && { date }),
	};
}

// What changed on one comment that exists both before and after.
function transitions(
	id: string,
	path: string,
	prev: Snapshot,
	next: Snapshot,
): CommentEvent[] {
	const out: CommentEvent[] = [];
	// New replies only. A reply removed, or edited in place, reports nothing:
	// the count is the signal, and a thread that shrank has no new reply.
	for (const r of next.replies.slice(prev.replies.length)) {
		out.push({
			...base('replied', id, path, next),
			...actor(r.author, r.date),
		});
	}
	if (!prev.addressed && next.addressed) {
		out.push({
			...base('addressed', id, path, next),
			...actor(next.addressed.author, next.addressed.date),
		});
	}
	if (!prev.resolution && next.resolution) {
		out.push({
			...base('resolved', id, path, next),
			...actor(next.resolution.author, next.resolution.date),
		});
	} else if (prev.resolution && !next.resolution) {
		out.push(base('reopened', id, path, next));
	}
	return out;
}

export class CommentEventTracker {
	// The last settled state of every note this session has seen.
	private readonly settled = new Map<string, NoteSnapshot>();
	// Notes changed since the last flush, at their newest parse.
	private readonly pending = new Map<string, NoteSnapshot>();
	// Pending notes that no longer exist: forgotten after the flush.
	private readonly gone = new Set<string>();
	// Until the vault has been indexed once, a note seen for the first time is
	// not news: it was there before Annoteca loaded. After that, a note seen
	// for the first time arrived (created, synced in), and its comments are.
	private armed = false;

	get isArmed(): boolean {
		return this.armed;
	}

	// Changes seen before arming are folded into the baseline unreported:
	// the resync that marks arming tells consumers to read the vault as it is,
	// and an event from before that line would be reported twice.
	arm(): void {
		this.armed = true;
		for (const [path, next] of this.pending) {
			if (this.gone.has(path)) this.settled.delete(path);
			else this.settled.set(path, next);
		}
		this.pending.clear();
		this.gone.clear();
	}

	changed(path: string, comments: readonly Comment[]): void {
		const snap = snapshotNote(comments);
		this.gone.delete(path);
		if (!this.armed && !this.settled.has(path) && !this.pending.has(path)) {
			this.settled.set(path, snap);
			return;
		}
		this.pending.set(path, snap);
	}

	removed(path: string): void {
		if (!this.settled.has(path) && !this.pending.has(path)) return;
		this.pending.set(path, new Map());
		this.gone.add(path);
	}

	// A rename moves every comment in the note. Reported as moved per comment,
	// by the flush pairing each one's disappearance from the old path with its
	// appearance at the new one.
	renamed(oldPath: string, newPath: string): void {
		const latest = this.pending.get(oldPath) ?? this.settled.get(oldPath);
		if (latest === undefined) return;
		this.gone.delete(newPath);
		this.pending.set(newPath, latest);
		this.pending.set(oldPath, new Map());
		this.gone.add(oldPath);
	}

	get hasPending(): boolean {
		return this.pending.size > 0;
	}

	// Every change since the last flush, and the new settled state.
	flush(): CommentEvent[] {
		const appeared: { id: string; path: string; s: Snapshot }[] = [];
		const vanished: { id: string; path: string; s: Snapshot }[] = [];
		const changes: CommentEvent[] = [];
		for (const [path, next] of this.pending) {
			const prev = this.settled.get(path) ?? new Map<string, Snapshot>();
			for (const [id, s] of next) {
				const before = prev.get(id);
				if (before === undefined) appeared.push({ id, path, s });
				else changes.push(...transitions(id, path, before, s));
			}
			for (const [id, s] of prev) {
				if (!next.has(id)) vanished.push({ id, path, s });
			}
		}

		const out: CommentEvent[] = [];
		const used = new Set<number>();
		// The vanished comments by id, in order, so each appeared one looks
		// up its own id instead of searching them all: a renamed note with
		// many comments made that quadratic. Each id's list keeps a cursor
		// past the entries already taken, so many notes sharing one copied id
		// do not rescan them either. A note holds an id at most once, so at
		// most one entry (the appearing note's own) is passed over per lookup.
		const vanishedById = new Map<
			string,
			{ list: number[]; from: number }
		>();
		vanished.forEach((v, n) => {
			const entry = vanishedById.get(v.id);
			if (entry) entry.list.push(n);
			else vanishedById.set(v.id, { list: [n], from: 0 });
		});
		const takeVanished = (id: string, path: string): number => {
			const entry = vanishedById.get(id);
			if (entry === undefined) return -1;
			while (
				entry.from < entry.list.length &&
				used.has(entry.list[entry.from] ?? -1)
			)
				entry.from += 1;
			for (let k = entry.from; k < entry.list.length; k++) {
				const n = entry.list[k];
				if (n === undefined || used.has(n)) continue;
				if (vanished[n]?.path !== path) return n;
			}
			return -1;
		};
		for (const a of appeared) {
			const i = takeVanished(a.id, a.path);
			if (i === -1) {
				out.push({
					...base('created', a.id, a.path, a.s),
					...actor(a.s.author, a.s.date),
				});
				continue;
			}
			used.add(i);
			const from = vanished[i];
			if (from === undefined) continue;
			out.push({
				...base('moved', a.id, a.path, a.s),
				oldPath: from.path,
			});
			out.push(...transitions(a.id, a.path, from.s, a.s));
		}
		out.push(...changes);
		vanished.forEach((v, n) => {
			if (!used.has(n)) out.push(base('deleted', v.id, v.path, v.s));
		});

		for (const [path, next] of this.pending) {
			if (this.gone.has(path)) this.settled.delete(path);
			else this.settled.set(path, next);
		}
		this.pending.clear();
		this.gone.clear();
		return out;
	}
}

// Run `fn` once things go quiet for `quietMs`, but never later than `maxMs`
// after the first call of a burst, so a note being edited continuously still
// reports. Returns the trigger and a cancel for unload.
export function debounceWithMaxWait(
	fn: () => void,
	quietMs: number,
	maxMs: number,
	now: () => number = Date.now,
): { trigger: () => void; cancel: () => void } {
	let timer: number | undefined;
	let burstStart: number | undefined;
	const cancel = (): void => {
		if (timer !== undefined) window.clearTimeout(timer);
		timer = undefined;
		burstStart = undefined;
	};
	return {
		trigger: (): void => {
			const t = now();
			burstStart ??= t;
			if (timer !== undefined) window.clearTimeout(timer);
			const wait = Math.max(0, Math.min(quietMs, burstStart + maxMs - t));
			timer = window.setTimeout(() => {
				timer = undefined;
				burstStart = undefined;
				fn();
			}, wait);
		},
		cancel,
	};
}
