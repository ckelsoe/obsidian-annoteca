// Anchoring hardening, part B: notice a comment that disappeared.
//
// A comment lives in its note as a marker, so anything that rewrites the note
// can drop it: an AI agent or a formatter rewriting a paragraph, a sync
// conflict, a cut that is never pasted, a hand edit. Annoteca's own deletes
// say so first (expectRemoval). Anything else that makes a comment vanish from
// a note that still exists is reported, with the comment as it last was, so it
// can be put back.
//
// Only notes indexed this session are watched: a comment's last state is what
// the index last saw. A comment that vanishes and comes back within the grace
// period (cut then paste, an editor buffer and the saved file briefly
// disagreeing) is not reported. A note that was deleted takes its comments with
// it on purpose and is not reported either.

import type { Comment } from './types';

export interface LostComment {
	readonly id: string;
	readonly path: string;
	readonly comment: Comment;
	// Where its marker was, for putting it back near there.
	readonly at: number;
}

export interface LossGuardDeps {
	// Whether the note is still there.
	exists(path: string): boolean;
	// Whether a comment with this id is anywhere in the index now.
	located(id: string): boolean;
	report(batch: readonly LostComment[]): void;
	now?: () => number;
	graceMs?: number;
}

const EXPECT_MS = 60_000;
const MAX_KEPT = 50;

export class LossGuard {
	private readonly known = new Map<string, Map<string, Comment>>();
	private readonly expected = new Map<string, number>();
	private pending: LostComment[] = [];
	private timer: number | undefined;
	// This session's losses, newest first, for putting back later.
	readonly lost: LostComment[] = [];

	constructor(private readonly deps: LossGuardDeps) {}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	// Annoteca is about to remove this comment on purpose.
	expectRemoval(id: string): void {
		this.expected.set(id, this.now() + EXPECT_MS);
	}

	changed(path: string, comments: readonly Comment[]): void {
		const next = new Map<string, Comment>();
		for (const c of comments)
			if (c.id && !next.has(c.id)) next.set(c.id, c);
		const prev = this.known.get(path);
		this.known.set(path, next);
		if (!prev) return;
		for (const [id, c] of prev) {
			if (next.has(id)) continue;
			const until = this.expected.get(id);
			if (until !== undefined && until >= this.now()) {
				this.expected.delete(id);
				continue;
			}
			this.pending.push({ id, path, comment: c, at: c.marker.start });
			this.schedule();
		}
	}

	// The note is gone: deleted on purpose, with its comments.
	removed(path: string): void {
		this.known.delete(path);
		this.pending = this.pending.filter((p) => p.path !== path);
	}

	renamed(oldPath: string, newPath: string): void {
		const prev = this.known.get(oldPath);
		this.known.delete(oldPath);
		if (prev) this.known.set(newPath, prev);
	}

	// Put back, or no longer wanted.
	forget(id: string): void {
		const i = this.lost.findIndex((l) => l.id === id);
		if (i !== -1) this.lost.splice(i, 1);
	}

	dispose(): void {
		if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = [];
	}

	private schedule(): void {
		if (this.timer !== undefined) return;
		this.timer = window.setTimeout(
			() => this.flush(),
			this.deps.graceMs ?? 4000,
		);
	}

	private flush(): void {
		this.timer = undefined;
		const seen = new Set<string>();
		const batch = this.pending.filter((p) => {
			if (seen.has(p.id)) return false;
			seen.add(p.id);
			return this.deps.exists(p.path) && !this.deps.located(p.id);
		});
		this.pending = [];
		if (batch.length === 0) return;
		for (const b of batch) this.forget(b.id);
		this.lost.unshift(...batch);
		this.lost.splice(MAX_KEPT);
		this.deps.report(batch);
	}
}
