// Comment lifecycle service. Owns the verbs that mutate a marker in the
// vault and rebuild the in-memory index: resolve / reopen / delete / append
// reply / replace, plus bulk operations and the resolved-author helper.
//
// AnnotecaPlugin keeps thin pass-through methods for the public API so
// external callers (the hub Thread tab, popup handlers) do not break, but
// the actual work lives here. parser.serialize is funneled through
// replaceMarker so future callers cannot bypass index rebuild + event
// emission.
//
// Editor-aware writes: when the file is currently open in any markdown leaf
// we mutate through `editor.transaction(...)` instead of `vault.modify(...)`.
// vault.modify on an open file can be silently clobbered by the editor's
// autosave flushing its (now stale) in-memory document back to disk,
// "restoring" the marker the user just resolved/deleted. Going through the
// editor keeps the in-memory document and disk in sync. The edit composer
// already used `editor.replaceRange` for the same reason.

import { MarkdownView, Notice, TFile } from 'obsidian';

import type AnnotecaPlugin from './main';
import type { ImportResult } from './imports';
import type { Addressed, Comment, MarkerRange, Reply } from './types';
import {
	findRemovalBlocker,
	parseAll,
	serialize,
	nowISO,
	type MalformedMarker,
} from './parser';

// What a lifecycle write actually did. Three outcomes rather than a boolean,
// because the caller's message differs: "declined" means the transition looked
// at the CURRENT state and chose not to act (already resolved, no longer
// addressed), while "missing" means the marker is gone and replaceMarker has
// already said so. Collapsing them produced two notices for one action.
// 'blocked' is separate from 'declined' for the same reason 'ambiguous' is
// separate from 'missing': the delegating callers narrate 'declined' as a stale
// transition ("Already resolved.", "This edit is no longer awaiting review."),
// and neither is true here. The comment is still open, or still addressed; the
// write was stopped by damage elsewhere in the note. Folding the two together
// put a damage notice and a contradictory false-state notice on screen at once.
export type WriteOutcome = 'written' | 'declined' | 'missing' | 'blocked';

// What re-finding a comment in the current file text produced. 'ambiguous' is
// its own case rather than folded into 'missing' because the user-facing
// message is different in kind: nothing has moved, reopening the note will not
// help, and the only fix is to go and change one of the duplicated ids.
type FreshLookup =
	| { kind: 'found'; comment: Comment }
	| { kind: 'missing' }
	| { kind: 'ambiguous'; id: string };

interface SpliceRange {
	from: number;
	to: number;
	insert: string;
}

// The two "this action's target is not there any more" messages, exported so the
// composer's edit path can refuse in the same words. It re-resolves its own
// marker (it writes through the editor rather than through this service), and a
// second copy of these strings would drift.
export const VANISHED_MESSAGE =
	'This comment has moved or been deleted since it was loaded. Reopen the note and try again.';

// Same reason, for "the file this action was aimed at is gone". The popover's
// lifecycle actions resolve their own file (they act on the note the popover
// belongs to, not the focused one) and have to refuse in these words rather
// than invent a second phrasing for the same situation.
export function fileGoneMessage(path: string): string {
	return `Could not open ${path}. It may have been renamed or deleted.`;
}

export function ambiguousMessage(id: string): string {
	return `More than one comment in this note has the identifier ${id}, so this action cannot tell which one you meant. Give one of them a different identifier, or delete the copy.`;
}

// "This note has a marker that never closed, and removing text now would hide
// more of it."
//
// The refusal that decision 1 asks for. A marker's `-->` is a document-wide
// token: while an opener above it has none of its own, that terminator is what
// ends the hidden region, and taking it away extends the region over more of the
// user's prose. Nothing about the note looks different afterwards in the editor,
// which is why this has to say so rather than proceed.
//
// The finding's own reason is quoted rather than restated, so the words the
// diagnostics report uses and the words this notice uses cannot drift.
// Says what to DO, not only what is wrong, and the two kinds need different
// instructions because they are different problems.
//
// An 'unclosed-opener' really is a missing terminator, and nothing inside the
// plugin supplies one: no write re-serializes an opener that sits outside every
// parsed marker, and the validation command reports without editing. The user
// typing `-->` is the whole fix, so the notice says so.
//
// A 'possible-merge' is NOT a missing terminator. It is an unescaped `<!--`
// inside a marker whose own `-->` may belong to that comment instead, and
// telling the user to add another terminator there would have them close the
// marker early and spill the rest into the document. That one is repaired by
// escaping the inner opener, which any ordinary write already does.
export function markerDamageMessage(finding: MalformedMarker): string {
	const fix =
		finding.kind === 'unclosed-opener'
			? 'Add the missing `-->` to close it, or run "Validate marker format" to see where it is.'
			: 'Escape the inner `<!--` as `\\<!--`, or run "Validate marker format" to see where it is.';
	return `Annoteca did not change this note. ${finding.reason} Removing a comment while that is unresolved would hide more of the note. ${fix}`;
}

// Every public mutating verb is a thin `enqueue` wrapper around a private
// `*Unqueued` method, and the verbs that delegate to one another call the
// unqueued form. Queueing at both layers would deadlock: resolveComment waiting
// on resolveAndRemoveComment, which is waiting behind resolveComment in the same
// queue.
export class CommentService {
	private readonly writeQueue = new Map<string, Promise<void>>();

	constructor(private readonly plugin: AnnotecaPlugin) {}

	async resolveComment(path: string, comment: Comment): Promise<void> {
		return this.enqueue(path, () =>
			this.resolveCommentUnqueued(path, comment),
		);
	}

	private async resolveCommentUnqueued(
		path: string,
		comment: Comment,
	): Promise<void> {
		if (comment.resolution) return;
		if (this.plugin.settings.deleteOnResolve) {
			// The toggle is the opt-in for destructive resolve; no per-action
			// confirmation here. The explicit "Resolve and remove" action keeps
			// its own confirmation for users who have NOT opted in globally.
			// Guarded on the CURRENT state, matching the branch below.
			const outcome = await this.resolveAndRemoveCommentUnqueued(
				path,
				comment,
				(c) => !c.resolution,
			);
			if (outcome === 'declined') new Notice('Already resolved.');
			return;
		}
		const author = this.resolvedAuthor();
		const outcome = await this.replaceMarkerUnqueued(
			path,
			comment,
			(current) =>
				current.resolution
					? undefined
					: {
							...current,
							resolution: { author, date: nowISO(), note: '' },
						},
		);
		if (outcome === 'written') new Notice('Resolved.');
		else if (outcome === 'declined') new Notice('Already resolved.');
	}

	// Resolve with file cleanup: removes the marker entirely instead of
	// writing a [resolved ...] line. The thread leaves the file; history, when
	// wanted, lives in git. Reached from the explicit "Resolve and remove"
	// action and from resolveComment when deleteOnResolve is enabled.
	// `stillApplies` is the freshness guard the delegating callers need. This is
	// the DESTRUCTIVE branch of resolve and accept, and it was the only lifecycle
	// path that re-resolved the marker's offsets without re-checking the state
	// the action was aimed at: with deleteOnResolve on, Accept deleted the
	// marker, its body and its whole thread even when another writer had already
	// revised or rejected the pending edit. The non-destructive branches decline
	// through replaceMarker's transition; this one skipped the check entirely.
	//
	// Omitted by the explicit "Resolve and remove" action, which is a deliberate
	// destructive choice with its own confirmation, so it keeps acting on
	// whatever is currently there.
	async resolveAndRemoveComment(
		path: string,
		comment: Comment,
		stillApplies?: (current: Comment) => boolean,
	): Promise<WriteOutcome> {
		return this.enqueue(path, () =>
			this.resolveAndRemoveCommentUnqueued(path, comment, stillApplies),
		);
	}

	private async resolveAndRemoveCommentUnqueued(
		path: string,
		comment: Comment,
		stillApplies?: (current: Comment) => boolean,
	): Promise<WriteOutcome> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.noticeFileGone(path);
			return 'missing';
		}
		const content = await this.readCurrentContent(file, path);
		// Removing a range is the least forgiving thing this service does, so a
		// marker it cannot identify aborts rather than deleting whatever now
		// occupies the cached offsets.
		const current = this.resolveFresh(content, comment);
		if (!current) {
			return 'missing';
		}
		if (stillApplies && !stillApplies(current)) return 'declined';
		// 'blocked', not 'declined'. refusesForDamage has already said what is
		// wrong; a caller that read this as a stale transition would follow it
		// with "Already resolved." about a comment that is still open.
		if (this.refusesForDamage(content, [current.marker])) return 'blocked';
		const { start, end } = current.marker;
		const splice = this.buildDeleteSplice(content, start, end);
		const wrote = await this.applySplices(path, file, [splice], content);
		if (!wrote) return 'missing';
		new Notice('Resolved and removed.');
		return 'written';
	}

	async reopenComment(path: string, comment: Comment): Promise<void> {
		return this.enqueue(path, () =>
			this.reopenCommentUnqueued(path, comment),
		);
	}

	private async reopenCommentUnqueued(
		path: string,
		comment: Comment,
	): Promise<void> {
		if (!comment.resolution) return;
		const outcome = await this.replaceMarkerUnqueued(
			path,
			comment,
			(current) =>
				current.resolution
					? { ...current, resolution: undefined }
					: undefined,
		);
		if (outcome === 'written') new Notice('Reopened.');
		// 'declined' means another writer reopened it first. Every sibling verb
		// narrates that; without this the button looks broken.
		else if (outcome === 'declined') new Notice('Already open.');
	}

	async deleteComment(path: string, comment: Comment): Promise<void> {
		return this.enqueue(path, () =>
			this.deleteCommentUnqueued(path, comment),
		);
	}

	private async deleteCommentUnqueued(
		path: string,
		comment: Comment,
	): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.noticeFileGone(path);
			return;
		}
		const content = await this.readCurrentContent(file, path);
		const current = this.resolveFresh(content, comment);
		if (!current) {
			return;
		}
		if (this.refusesForDamage(content, [current.marker])) return;
		const { start, end } = current.marker;
		const splice = this.buildDeleteSplice(content, start, end);
		const wrote = await this.applySplices(path, file, [splice], content);
		if (!wrote) return;
		new Notice('Deleted.');
	}

	// Appends to whatever replies the marker currently holds, not to the ones the
	// caller's snapshot was rendered with. This is the sharpest edge of #12: two
	// replies landing close together (an assistant answering while the user is
	// typing) would otherwise have the second write erase the first.
	//
	// Returns whether the reply actually landed. Callers MUST honour it: the
	// write can now be refused (the marker was deleted, or an id-less one changed
	// underneath), and the reply is text the user just typed. Reporting success
	// and clearing the composer on a refusal would destroy it, which is the same
	// class of loss this whole change is about.
	//
	// `path` is passed in rather than read from the active file. Replies come
	// from surfaces that are not tied to whatever is focused: a Hub card in a
	// folder or vault scope belongs to another note entirely, and a popover can
	// be open in a non-active split pane. Resolving the active file instead sent
	// the write at the wrong document.
	async appendReply(
		path: string,
		comment: Comment,
		reply: Reply,
	): Promise<boolean> {
		if (!path) return false;
		return this.enqueue(path, () =>
			this.appendReplyUnqueued(path, comment, reply),
		);
	}

	private async appendReplyUnqueued(
		path: string,
		comment: Comment,
		reply: Reply,
	): Promise<boolean> {
		const outcome = await this.replaceMarkerUnqueued(
			path,
			comment,
			(current) => ({
				...current,
				replies: [...current.replies, reply],
			}),
		);
		return outcome === 'written';
	}

	// ---- Addressed-state transitions (F-270) ---------------------------------
	// open ──applyAddressed──▶ addressed ──accept──▶ resolved
	//                              ├──revise──▶ open (drop the addressed line)
	//                              └──reject──▶ open (revert prose from original)

	// open → addressed. Marks a comment as addressed and pending review,
	// optionally carrying the verbatim replaced text so reject can revert it.
	// (The AI normally writes the [addressed ...] line directly into the file;
	// this is the programmatic transition for plugin-driven flows.)
	async applyAddressed(
		path: string,
		comment: Comment,
		note: string,
		original?: string,
	): Promise<void> {
		return this.enqueue(path, () =>
			this.applyAddressedUnqueued(path, comment, note, original),
		);
	}

	private async applyAddressedUnqueued(
		path: string,
		comment: Comment,
		note: string,
		original?: string,
	): Promise<void> {
		const addressed: Addressed = {
			author: this.resolvedAuthor(),
			date: nowISO(),
			note,
			original,
		};
		// Decline rather than overwrite. Every sibling transition inspects
		// `current` before it acts, and this one did not, so a second writer
		// (an assistant, another pane, a sync) that addressed the same comment
		// after this caller's snapshot had its author, date, note and original
		// replaced. The original is the ONLY revert source rejectAddressed has,
		// so that overwrite is unrecoverable text loss, not just a lost label.
		const outcome = await this.replaceMarkerUnqueued(
			path,
			comment,
			(current) =>
				current.addressed ? undefined : { ...current, addressed },
		);
		if (outcome === 'written') new Notice('Marked as addressed.');
		else if (outcome === 'declined')
			new Notice('This comment is already awaiting review.');
	}

	// addressed → resolved. The reviewer keeps the applied edit. Honors
	// deleteOnResolve exactly like resolveComment. The original fence is dropped
	// (revert is no longer needed; Git retains history).
	async acceptAddressed(path: string, comment: Comment): Promise<void> {
		return this.enqueue(path, () =>
			this.acceptAddressedUnqueued(path, comment),
		);
	}

	private async acceptAddressedUnqueued(
		path: string,
		comment: Comment,
	): Promise<void> {
		if (!comment.addressed) return;
		if (this.plugin.settings.deleteOnResolve) {
			// Refuse when the edit is no longer awaiting review. This branch
			// deletes the marker and its whole thread, so acting on a snapshot
			// here destroys more than any other path in this service.
			const outcome = await this.resolveAndRemoveCommentUnqueued(
				path,
				comment,
				(c) => Boolean(c.addressed),
			);
			if (outcome === 'declined')
				new Notice('This edit is no longer awaiting review.');
			return;
		}
		const author = this.resolvedAuthor();
		const outcome = await this.replaceMarkerUnqueued(
			path,
			comment,
			(current) =>
				current.addressed
					? {
							...current,
							addressed: undefined,
							resolution: {
								author,
								date: nowISO(),
								note: 'accepted',
							},
						}
					: undefined,
		);
		if (outcome === 'written') new Notice('Accepted.');
		else if (outcome === 'declined')
			new Notice('This edit is no longer awaiting review.');
	}

	// addressed → open. The reviewer wants to revise further: drop the
	// [addressed ...] line (and its fence) so the comment returns to the open
	// queue. The applied prose is left in place for the reviewer to edit.
	async reviseAddressed(path: string, comment: Comment): Promise<void> {
		return this.enqueue(path, () =>
			this.reviseAddressedUnqueued(path, comment),
		);
	}

	private async reviseAddressedUnqueued(
		path: string,
		comment: Comment,
	): Promise<void> {
		if (!comment.addressed) return;
		const outcome = await this.replaceMarkerUnqueued(
			path,
			comment,
			(current) =>
				current.addressed
					? { ...current, addressed: undefined }
					: undefined,
		);
		if (outcome === 'written') new Notice('Reopened for revision.');
		else if (outcome === 'declined')
			new Notice('This edit is no longer awaiting review.');
	}

	// addressed → open, auto-reverting the prose. Restores the annoteca-original
	// text (F-271) into the document and drops the [addressed ...] line. Under
	// beginning-placement the marker leads the replaced span, so the new prose is
	// the text immediately after the marker up to the end of that line; that span
	// is replaced with the stored original. With no stored original there is
	// nothing to revert, so this degrades to reviseAddressed. Git is the backstop
	// for multi-line replacements beyond the marker's line.
	async rejectAddressed(path: string, comment: Comment): Promise<void> {
		return this.enqueue(path, () =>
			this.rejectAddressedUnqueued(path, comment),
		);
	}

	private async rejectAddressedUnqueued(
		path: string,
		comment: Comment,
	): Promise<void> {
		const addressed = comment.addressed;
		if (!addressed) return;
		if (addressed.original === undefined) {
			await this.reviseAddressedUnqueued(path, comment);
			return;
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.noticeFileGone(path);
			return;
		}
		const content = await this.readCurrentContent(file, path);

		// This method splices directly instead of going through replaceMarker,
		// so it re-resolves the marker itself. Reject is the only action that
		// rewrites a span of PROSE as well as the marker, so acting on a stale
		// offset destroys the user's text rather than mangling a marker. It is
		// repeatable once the note catches up; overwritten prose is not.
		//
		// The identify-or-refuse rule this needs is now freshComment's, shared
		// with every other verb rather than stated twice. Its comment carries the
		// reasoning that was worked out here.
		const current = this.resolveFresh(content, comment);
		if (!current) {
			return;
		}
		// Everything from here reads `current`, never the caller's `comment`
		// (#12). Re-resolving only the OFFSETS fixed where the write lands; the
		// marker it wrote was still rebuilt from the snapshot, so a reply that
		// arrived after the card rendered was dropped by the revert.
		//
		// The original prose comes from `current.addressed` too. If the addressed
		// state is gone, someone accepted or revised this edit in the meantime and
		// there is nothing left to revert; splicing the snapshot's stored original
		// over the current line would overwrite prose the user has moved on from.
		const currentAddressed = current.addressed;
		if (!currentAddressed || currentAddressed.original === undefined) {
			new Notice('This edit is no longer awaiting review.');
			return;
		}
		// Reject rewrites a span of PROSE as well as the marker, which is the
		// same hazard as removing one: the span it computes runs from the end of
		// the marker to the end of that line, and in a note whose markers have
		// merged those offsets are not the ones the user is looking at.
		if (this.refusesForDamage(content, [current.marker])) return;

		const { start: markerStart, end: markerEnd } = current.marker;
		// Skip the single begin-placement space between the marker and the new
		// prose, if present.
		const proseStart =
			content.charAt(markerEnd) === ' ' ? markerEnd + 1 : markerEnd;
		const lineEnd = this.endOfLine(content, proseStart);

		const reopened: Comment = { ...current, addressed: undefined };
		const markerText = serialize({
			id: reopened.id,
			category: reopened.category,
			body: reopened.body,
			date: reopened.date,
			author: reopened.author,
			anchor: reopened.anchor,
			replies: reopened.replies,
			resolution: reopened.resolution,
			unknownLines: reopened.unknownLines,
		});

		const wrote = await this.applySplices(
			path,
			file,
			[
				{ from: markerStart, to: markerEnd, insert: markerText },
				{
					from: proseStart,
					to: lineEnd,
					insert: currentAddressed.original,
				},
			],
			content,
		);
		if (!wrote) return;
		new Notice('Reverted to the original text.');
	}

	private endOfLine(content: string, from: number): number {
		const idx = content.indexOf('\n', from);
		return idx === -1 ? content.length : idx;
	}

	// Returns the resolved comments in `path` without modifying the file.
	// Used by the delete-all-resolved command to size its confirmation modal.
	async listResolvedInFile(path: string): Promise<Comment[]> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return [];
		const content = await this.readCurrentContent(file, path);
		return parseAll(content).filter((c) => c.resolution !== undefined);
	}

	// Strips every resolved marker from `path` in a single file write. Returns
	// the number of markers removed, or `null` when the file could not be
	// opened at all. Caller is responsible for confirmation and for showing a
	// user-facing Notice on success.
	//
	// `null` rather than 0 because the two mean different things and the caller
	// reports the number: the note being renamed or deleted between the
	// confirmation and the write announced "Deleted 0 resolved comments", which
	// reads as "there were none" rather than "the file is gone". This path is
	// reachable, the modal sits between the check and the write.
	//
	// A refusal on marker damage returns null for the same reason. The sweep did
	// not happen, the service has already said why, and "Deleted 0 resolved
	// comments" would read as "there were none to delete".
	async deleteAllResolvedInFile(path: string): Promise<number | null> {
		return this.enqueue(path, () =>
			this.deleteAllResolvedInFileUnqueued(path),
		);
	}

	private async deleteAllResolvedInFileUnqueued(
		path: string,
	): Promise<number | null> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.noticeFileGone(path);
			return null;
		}
		const content = await this.readCurrentContent(file, path);
		const resolved = parseAll(content).filter(
			(c) => c.resolution !== undefined,
		);
		if (resolved.length === 0) return 0;
		// One scan for the whole sweep, asking the same question of every marker
		// it is about to remove. null rather than 0, matching the file-is-gone
		// case: the service has already said what happened, and a count here
		// would claim deletions that did not happen.
		if (
			this.refusesForDamage(
				content,
				resolved.map((c) => c.marker),
			)
		)
			return null;

		// Bulk cleanup intent is "tidy the file", not "remove this exact span",
		// so when a marker occupies its own line we also strip the trailing
		// newline to avoid a stranded blank line.
		const splices: SpliceRange[] = [];
		for (const c of resolved) {
			let start = c.marker.start;
			let end = c.marker.end;
			const standsAlone =
				(start === 0 || content.charAt(start - 1) === '\n') &&
				(end === content.length || content.charAt(end) === '\n');
			if (standsAlone && end < content.length) {
				end += 1;
			} else if (start > 0 && content.charAt(start - 1) === ' ') {
				start -= 1;
			}
			splices.push({ from: start, to: end, insert: '' });
		}

		const wrote = await this.applySplices(path, file, splices, content);
		// null, matching the file-is-gone case: the service has already said
		// what happened, and a count here would claim a deletion that did not
		// happen.
		if (!wrote) return null;
		return resolved.length;
	}

	// Single funnel for parser.serialize + write + index rebuild +
	// "index-changed" event. Every comment-lifecycle write goes through here so
	// future callers cannot bypass index rebuild or event emission.
	//
	// `apply` receives the marker's CURRENT contents, re-read from the file, and
	// returns what to write, or undefined to abort without writing. Returns
	// whether a write happened, so callers can pick the right Notice.
	//
	// Taking a transition rather than a finished `next` comment is what fixes
	// #12. Callers hold a Comment captured when a Hub card was rendered, and
	// building `{...cached, resolution}` serializes that whole snapshot: its
	// replies, author, timestamps and addressed state as of render time. A reply
	// arriving between the card being drawn and the button being pressed was
	// silently discarded by the next write. Re-resolving offsets, which this
	// already did, only ever fixed WHERE the write landed, never WHAT it wrote.
	//
	// Costs no extra read: the content fetch was already here for the offsets.
	// On the paths that pass a live marker straight from the editor (the popover,
	// the at-cursor commands) the re-resolution finds the same object it was
	// given, so it is a no-op rather than an extra round trip.
	async replaceMarker(
		path: string,
		prev: Comment,
		apply: (current: Comment) => Comment | undefined,
	): Promise<WriteOutcome> {
		return this.enqueue(path, () =>
			this.replaceMarkerUnqueued(path, prev, apply),
		);
	}

	private async replaceMarkerUnqueued(
		path: string,
		prev: Comment,
		apply: (current: Comment) => Comment | undefined,
	): Promise<WriteOutcome> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.noticeFileGone(path);
			return 'missing';
		}
		const content = await this.readCurrentContent(file, path);
		const current = this.resolveFresh(content, prev);
		if (!current) return 'missing';
		const next = apply(current);
		if (!next) return 'declined';
		const serialized = serialize({
			id: next.id,
			category: next.category,
			body: next.body,
			date: next.date,
			author: next.author,
			anchor: next.anchor,
			replies: next.replies,
			addressed: next.addressed,
			resolution: next.resolution,
			unknownLines: next.unknownLines,
		});
		const wrote = await this.applySplices(
			path,
			file,
			[
				{
					from: current.marker.start,
					to: current.marker.end,
					insert: serialized,
				},
			],
			content,
		);
		// 'missing' rather than 'written': applySplices has already narrated the
		// refusal, and 'missing' is the outcome that makes appendReply return
		// false so the popover keeps the reply the user typed.
		return wrote ? 'written' : 'missing';
	}

	// Bulk import's per-file write, which is a write this plugin CONTROLS and so
	// belongs in the queue with every other verb.
	//
	// It used to live in main.ts as `vault.read` -> convert -> `vault.modify`,
	// the one mutating path neither the queue nor the staleness check covered,
	// and the doc comment on `enqueue` below claimed exactly that gap was closed.
	// Two failures came out of it, both executed against a real filesystem:
	//
	//   1. LOST WRITE. A Resolve clicked while the sweep runs lands through
	//      `vault.process`, then bulk convert's blind `modify` of a document it
	//      read BEFORE that puts the old text back. The note comes back with no
	//      `[resolved ...]` line while the only notice the user saw was
	//      "Resolved." Reproduced at 2 of 72 trials on real I/O, and
	//      deterministically under a strict per-file FIFO vault, because the
	//      staleness lives in the sweep's own read and the writer had no guard.
	//   2. CLOBBERED BY AUTOSAVE. `vault.modify` on a file open in an editor is
	//      what the header of this file says must never happen: the editor
	//      flushes its now-stale buffer back over the write.
	//
	// The conversion runs INSIDE the write rather than before it, which is what
	// makes the count honest. `convert` is pure and synchronous, so it can run
	// inside `vault.process`'s callback, and the number returned is the number
	// that was computed from the bytes actually written.
	// The content a write to this path would be computed from: the editor's
	// buffer when the note is open in one, the vault's cache otherwise.
	//
	// Exists so a caller deciding whether to bother writing asks the same source
	// the write itself will. `cachedRead` alone is not that source: it lags an
	// open editor by everything the user has typed since the last save, so a
	// sweep that pre-filtered on it skipped the note a comment had just been
	// typed into and reported that there had been nothing to convert. Bulk
	// convert visits each file once, so there is no later pass to catch it.
	async currentContentFor(path: string, file: TFile): Promise<string> {
		return this.contentFor(path, file, (f) =>
			this.plugin.app.vault.cachedRead(f),
		);
	}

	async convertFileComments(
		path: string,
		file: TFile,
		convert: (content: string) => ImportResult,
	): Promise<number> {
		return this.enqueue(path, () =>
			this.convertFileCommentsUnqueued(path, file, convert),
		);
	}

	private async convertFileCommentsUnqueued(
		path: string,
		file: TFile,
		convert: (content: string) => ImportResult,
	): Promise<number> {
		const view = this.getOpenMarkdownView(path);
		if (view) {
			// The editor's document is the truth for an open file, and writing
			// back through it is what keeps the buffer and the disk in step.
			// Replaced whole rather than spliced: "Convert all" is two passes and
			// the second pass's offsets index the FIRST pass's output, so splices
			// composed across them would be applied to the wrong string. The
			// operation is a confirmed vault-wide rewrite, so collapsing it to one
			// undo step is the honest shape for it anyway.
			const current = view.editor.getValue();
			const result = convert(current);
			if (result.converted === 0) return 0;
			view.editor.replaceRange(
				result.updated,
				view.editor.offsetToPos(0),
				view.editor.offsetToPos(current.length),
			);
			this.plugin.commentIndex.rebuild(path, result.updated);
			this.plugin.events.trigger('index-changed', { path });
			return result.converted;
		}
		let converted = 0;
		// Read, convert and write under one lock. Returning `current` unchanged
		// when there is nothing to convert matters: the caller pre-filters off the
		// cache, but the cache can be stale, and rewriting identical bytes would
		// touch mtime on the file and hand every sync client a spurious change.
		const updated = await this.plugin.app.vault.process(file, (current) => {
			const result = convert(current);
			converted = result.converted;
			return result.converted === 0 ? current : result.updated;
		});
		if (converted === 0) return 0;
		this.plugin.commentIndex.rebuild(path, updated);
		this.plugin.events.trigger('index-changed', { path });
		return converted;
	}

	// Reads the tag; it does not repair it. `normalizeSettings` is the single
	// ingress for data.json and already runs `authorTag` through the token
	// grammar, so anything reaching here is a string that is either empty or a
	// valid token. The `.trim()` this used to do was a second, weaker copy of
	// that rule living outside the choke point, and it also threw outright on a
	// non-string tag from a hand-edited file, which is the exact failure the
	// normalizer exists to absorb.
	//
	// Empty still means "no tag set", which is a settings question rather than a
	// grammar one and so is answered here rather than by the validator.
	resolvedAuthor(): string {
		const tag = this.plugin.settings.authorTag;
		if (this.plugin.settings.enableAuthorTag && tag !== '') return tag;
		return 'user';
	}

	// ---- internals -----------------------------------------------------

	private getOpenMarkdownView(path: string): MarkdownView | undefined {
		const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path)
				return view;
		}
		return undefined;
	}

	// Where this service's idea of a note's current text comes from. If the file
	// is open in an editor, the editor's value is the truth (it may have unsaved
	// typing the user expects to keep). Otherwise it comes from the vault, and
	// WHICH vault read is the only thing the two callers below disagree about.
	private async contentFor(
		path: string,
		file: TFile,
		read: (f: TFile) => Promise<string>,
	): Promise<string> {
		const view = this.getOpenMarkdownView(path);
		if (view) return view.editor.getValue();
		return read(file);
	}

	// Read the truth that a subsequent write must reconcile with, which is worth
	// a fresh read: applySplices compares against it and refuses on a mismatch,
	// so a cached copy would turn an ordinary write into a spurious refusal.
	private readCurrentContent(file: TFile, path: string): Promise<string> {
		return this.contentFor(path, file, (f) =>
			this.plugin.app.vault.read(f),
		);
	}

	// Re-resolve a comment against the current file content, returning the LIVE
	// marker, or undefined when it can no longer be identified. Callers (the
	// Thread panel especially) hold a comment cached when a card was rendered:
	// its marker.start/end can be stale if the document changed since, and so
	// can everything else about it. Splicing on stale offsets removes the wrong
	// range; serializing stale contents discards whatever landed in between.
	//
	// There is no fallback to the caller's own comment, which is the important
	// part. An earlier version returned it when the id lookup failed, so a card
	// for a marker that had since been DELETED wrote at offsets now pointing at
	// unrelated prose: resolve would overwrite that text with a marker, and
	// delete would remove it. A failed lookup means "gone", and gone must abort.
	//
	// Id-less markers stay supported, because the format supports them and
	// refusing outright would break them permanently even from the live editor
	// where offsets are perfectly fresh. They resolve by fingerprint instead:
	// same range, same category, same body. That cannot land on a different
	// comment, because a different comment would have to be byte-identical at
	// the same offset, which makes it the same marker for this purpose.
	//
	// This is the predicate rejectAddressed worked out across four review rounds
	// in PR A; it is shared now rather than written twice.
	private freshComment(content: string, comment: Comment): FreshLookup {
		const parsed = parseAll(content);
		if (comment.id !== undefined) {
			// Exactly one, or refuse. Ids live in file text, so copy-pasting a
			// marker inside a note produces two markers carrying the same id,
			// and `find` would hand back the first one whether or not it is the
			// marker the card points at. The id-less branch below is already
			// this strict.
			//
			// 'ambiguous' rather than 'missing' because the two need different
			// words. "Moved or deleted, reopen the note" is false for a
			// duplicated id, and reopening cannot fix it, so it would leave
			// every action dead with no way to understand why.
			const matches = parsed.filter((c) => c.id === comment.id);
			const only = matches[0];
			if (matches.length === 1 && only !== undefined)
				return { kind: 'found', comment: only };
			return matches.length > 1
				? { kind: 'ambiguous', id: comment.id }
				: { kind: 'missing' };
		}
		const found = parsed.find(
			(c) =>
				c.marker.start === comment.marker.start &&
				c.marker.end === comment.marker.end &&
				c.category === comment.category &&
				c.body === comment.body,
		);
		return found === undefined
			? { kind: 'missing' }
			: { kind: 'found', comment: found };
	}

	// Look the marker up and narrate the failure, so the four write paths do not
	// each have to remember which message goes with which kind of miss.
	private resolveFresh(
		content: string,
		comment: Comment,
	): Comment | undefined {
		const lookup = this.freshComment(content, comment);
		if (lookup.kind === 'found') return lookup.comment;
		if (lookup.kind === 'ambiguous') this.noticeAmbiguous(lookup.id);
		else this.noticeVanished();
		return undefined;
	}

	// One message for "the file this action was aimed at is gone". A Hub card can
	// outlive its note: folder and vault scopes render cards for files the user
	// is not looking at, and one of those can be renamed or deleted between the
	// render and the button press. Every write path used to return silently here,
	// so the button simply did nothing.
	private noticeFileGone(path: string): void {
		new Notice(fileGoneMessage(path));
	}

	// One message for "the marker this action was aimed at is not there any
	// more". Repeatable once the note catches up, unlike whatever a stale-offset
	// write would have destroyed. The wording covers deletion as well as
	// movement, because the id lookup cannot tell the two apart.
	private noticeVanished(): void {
		new Notice(VANISHED_MESSAGE);
	}

	// The guard the three removing verbs and the prose-rewriting one share.
	//
	// Every one of them re-resolves its target and then splices, and the splice
	// is what makes a damaged note worse: an unclosed opener above the target
	// has no terminator of its own, so the target's `-->` is what currently ends
	// the hidden region. Refusing is the conservative answer because this cannot
	// know which `-->` the user meant to write, and guessing edits their
	// document. The action is repeatable once the marker is closed.
	//
	// Only these verbs. Resolve, reply and edit go through replaceMarker, which
	// writes a marker back in place of a marker: the terminator survives, so the
	// hidden region does not grow, and refusing there would leave a user unable
	// to work in a note at all until they had gone marker-hunting.
	//
	// One of those writes repairs a 'possible-merge', because the unescaped
	// `<!--` it is reported for lives in a body that serialize escapes on the
	// way out. It does NOT repair an 'unclosed-opener': that opener sits outside
	// every parsed marker, so no write re-serializes it, and only the user
	// typing the missing `-->` clears it. An earlier version of this comment
	// claimed both, which would have sent someone looking for a repair that
	// never happens.
	private refusesForDamage(
		content: string,
		markers: readonly MarkerRange[],
	): boolean {
		const blocker = findRemovalBlocker(content, markers);
		if (!blocker) return false;
		new Notice(markerDamageMessage(blocker));
		return true;
	}

	// One message for "this note has two comments with the same identifier".
	// Deliberately not the vanished wording: nothing has moved, reopening the
	// note changes nothing, and the user cannot act on it without being told
	// what is actually wrong and which identifier to go and find.
	private noticeAmbiguous(id: string): void {
		new Notice(ambiguousMessage(id));
	}

	private buildDeleteSplice(
		content: string,
		start: number,
		end: number,
	): SpliceRange {
		// Drop the marker plus any trailing space introduced by range insertion.
		let from = start;
		const to = end;
		if (from > 0 && content.charAt(from - 1) === ' ') from -= 1;
		return { from, to, insert: '' };
	}

	// Apply a set of splices to a file, mutating via the editor's transaction
	// API when the file is open (keeps in-memory document and disk in sync,
	// avoids autosave clobber) and falling back to the vault otherwise.
	// Always rebuilds the index and fires "index-changed" after the write.
	//
	// `expected` is the EXACT content the caller computed its offsets against,
	// and this refuses to write when the file no longer matches it.
	//
	// It used to read the file a SECOND time here and apply the caller's offsets
	// to whatever came back. Every verb therefore had a window between its own
	// read and this one, and both failure modes were reproduced: a sync write
	// landing in that window spliced a `[resolved ...]` line into the middle of a
	// word and left two markers sharing an id, and the file had no marker where
	// the offsets said one was.
	//
	// Refusing is the right answer rather than re-resolving, because this
	// function does not know what the caller was trying to do. The caller's
	// freshness guards already decided that; the action is repeatable once the
	// note catches up, and prose overwritten by a stale splice is not.
	//
	// Returns whether the write happened. Callers MUST honour it: a refusal here
	// looks exactly like a success to the code above unless it is propagated, and
	// then a verb reports "Reply added." and the popover clears the draft while
	// nothing reached the file. That is the same class of loss as the race this
	// guard exists to stop, arriving one layer up.
	private async applySplices(
		path: string,
		file: TFile,
		splices: SpliceRange[],
		expected: string,
	): Promise<boolean> {
		if (splices.length === 0) return false;

		// Apply in reverse so earlier splices do not shift later offsets.
		const sorted = [...splices].sort((a, b) => a.from - b.from);
		const spliced = (source: string): string => {
			let out = source;
			for (let i = sorted.length - 1; i >= 0; i--) {
				const s = sorted[i];
				if (!s) continue;
				out = out.slice(0, s.from) + s.insert + out.slice(s.to);
			}
			return out;
		};

		const view = this.getOpenMarkdownView(path);
		let updated: string;

		if (view) {
			if (view.editor.getValue() !== expected) {
				this.noticeVanished();
				return false;
			}
			updated = spliced(expected);
			// Via editor.replaceRange, the same API the edit composer uses. It
			// keeps the CodeMirror EditorState authoritative; Obsidian persists
			// the editor's content, so a vault write is not needed here and
			// would race the editor's autosave.
			for (let i = sorted.length - 1; i >= 0; i--) {
				const s = sorted[i];
				if (!s) continue;
				view.editor.replaceRange(
					s.insert,
					view.editor.offsetToPos(s.from),
					view.editor.offsetToPos(s.to),
				);
			}
		} else {
			// vault.process reads and writes under one lock, so nothing can land
			// between the comparison and the write. read + modify could not
			// promise that however carefully it compared.
			let stale = false;
			updated = await this.plugin.app.vault.process(file, (current) => {
				if (current !== expected) {
					stale = true;
					return current;
				}
				return spliced(current);
			});
			if (stale) {
				this.noticeVanished();
				return false;
			}
		}

		this.plugin.commentIndex.rebuild(path, updated);
		this.plugin.events.trigger('index-changed', { path });
		return true;
	}

	// Serialize this plugin's own writes per file.
	//
	// The staleness check above is the backstop for writers this plugin does not
	// control (a sync, another app, the user in another editor). This is for the
	// ones it does: every verb reads, computes offsets from what it read, and
	// then writes, and two verbs in flight against the same note interleave those
	// steps. Executed: `Promise.all` of two resolves on different comments in one
	// file silently lost the first write while both reported "Resolved."
	//
	// The READ has to be inside the critical section, not just the write, which
	// is why this wraps whole verbs rather than sitting inside applySplices.
	private enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
		const previous = this.writeQueue.get(path) ?? Promise.resolve();
		// `then(task, task)`: a verb that threw must not wedge every later write
		// to the same file behind a rejected promise.
		const result = previous.then(task, task);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.writeQueue.set(path, tail);
		void tail.then(() => {
			// Identity check: by now a later verb may already have replaced the
			// tail, and deleting that one would let the next verb start early.
			if (this.writeQueue.get(path) === tail)
				this.writeQueue.delete(path);
		});
		return result;
	}
}
