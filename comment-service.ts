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
import type { Addressed, Comment, Reply } from './types';
import { parseAll, serialize, nowISO } from './parser';

// What a lifecycle write actually did. Three outcomes rather than a boolean,
// because the caller's message differs: "declined" means the transition looked
// at the CURRENT state and chose not to act (already resolved, no longer
// addressed), while "missing" means the marker is gone and replaceMarker has
// already said so. Collapsing them produced two notices for one action.
type WriteOutcome = 'written' | 'declined' | 'missing';

interface SpliceRange {
	from: number;
	to: number;
	insert: string;
}

export class CommentService {
	constructor(private readonly plugin: AnnotecaPlugin) {}

	async resolveComment(path: string, comment: Comment): Promise<void> {
		if (comment.resolution) return;
		if (this.plugin.settings.deleteOnResolve) {
			// The toggle is the opt-in for destructive resolve; no per-action
			// confirmation here. The explicit "Resolve and remove" action keeps
			// its own confirmation for users who have NOT opted in globally.
			// Guarded on the CURRENT state, matching the branch below.
			const outcome = await this.resolveAndRemoveComment(
				path,
				comment,
				(c) => !c.resolution,
			);
			if (outcome === 'declined') new Notice('Already resolved.');
			return;
		}
		const author = this.resolvedAuthor();
		const outcome = await this.replaceMarker(path, comment, (current) =>
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
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return 'missing';
		const content = await this.readCurrentContent(file, path);
		// Removing a range is the least forgiving thing this service does, so a
		// marker it cannot identify aborts rather than deleting whatever now
		// occupies the cached offsets.
		const current = this.freshComment(content, comment);
		if (!current) {
			this.noticeVanished();
			return 'missing';
		}
		if (stillApplies && !stillApplies(current)) return 'declined';
		const { start, end } = current.marker;
		const splice = this.buildDeleteSplice(content, start, end);
		await this.applySplices(path, file, [splice]);
		new Notice('Resolved and removed.');
		return 'written';
	}

	async reopenComment(path: string, comment: Comment): Promise<void> {
		if (!comment.resolution) return;
		const outcome = await this.replaceMarker(path, comment, (current) =>
			current.resolution
				? { ...current, resolution: undefined }
				: undefined,
		);
		if (outcome === 'written') new Notice('Reopened.');
	}

	async deleteComment(path: string, comment: Comment): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const content = await this.readCurrentContent(file, path);
		const current = this.freshComment(content, comment);
		if (!current) {
			this.noticeVanished();
			return;
		}
		const { start, end } = current.marker;
		const splice = this.buildDeleteSplice(content, start, end);
		await this.applySplices(path, file, [splice]);
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
	async appendReply(comment: Comment, reply: Reply): Promise<boolean> {
		const path = this.plugin.app.workspace.getActiveFile()?.path;
		if (!path) return false;
		const outcome = await this.replaceMarker(path, comment, (current) => ({
			...current,
			replies: [...current.replies, reply],
		}));
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
		const addressed: Addressed = {
			author: this.resolvedAuthor(),
			date: nowISO(),
			note,
			original,
		};
		const outcome = await this.replaceMarker(path, comment, (current) => ({
			...current,
			addressed,
		}));
		if (outcome === 'written') new Notice('Marked as addressed.');
	}

	// addressed → resolved. The reviewer keeps the applied edit. Honors
	// deleteOnResolve exactly like resolveComment. The original fence is dropped
	// (revert is no longer needed; Git retains history).
	async acceptAddressed(path: string, comment: Comment): Promise<void> {
		if (!comment.addressed) return;
		if (this.plugin.settings.deleteOnResolve) {
			// Refuse when the edit is no longer awaiting review. This branch
			// deletes the marker and its whole thread, so acting on a snapshot
			// here destroys more than any other path in this service.
			const outcome = await this.resolveAndRemoveComment(
				path,
				comment,
				(c) => Boolean(c.addressed),
			);
			if (outcome === 'declined')
				new Notice('This edit is no longer awaiting review.');
			return;
		}
		const author = this.resolvedAuthor();
		const outcome = await this.replaceMarker(path, comment, (current) =>
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
		if (!comment.addressed) return;
		const outcome = await this.replaceMarker(path, comment, (current) =>
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
		const addressed = comment.addressed;
		if (!addressed) return;
		if (addressed.original === undefined) {
			await this.reviseAddressed(path, comment);
			return;
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
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
		const current = this.freshComment(content, comment);
		if (!current) {
			this.noticeVanished();
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
		});

		await this.applySplices(path, file, [
			{ from: markerStart, to: markerEnd, insert: markerText },
			{
				from: proseStart,
				to: lineEnd,
				insert: currentAddressed.original,
			},
		]);
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
	// the number of markers removed. Caller is responsible for confirmation
	// and for showing a user-facing Notice.
	async deleteAllResolvedInFile(path: string): Promise<number> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return 0;
		const content = await this.readCurrentContent(file, path);
		const resolved = parseAll(content).filter(
			(c) => c.resolution !== undefined,
		);
		if (resolved.length === 0) return 0;

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

		await this.applySplices(path, file, splices);
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
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return 'missing';
		const content = await this.readCurrentContent(file, path);
		const current = this.freshComment(content, prev);
		if (!current) {
			this.noticeVanished();
			return 'missing';
		}
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
		});
		await this.applySplices(path, file, [
			{
				from: current.marker.start,
				to: current.marker.end,
				insert: serialized,
			},
		]);
		return 'written';
	}

	resolvedAuthor(): string {
		const tag = this.plugin.settings.authorTag.trim();
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

	// Read the truth that a subsequent write must reconcile with. If the file
	// is open in an editor, the editor's value is the truth (it may have
	// unsaved typing the user expects to keep). Otherwise read from vault.
	private async readCurrentContent(
		file: TFile,
		path: string,
	): Promise<string> {
		const view = this.getOpenMarkdownView(path);
		if (view) return view.editor.getValue();
		return this.plugin.app.vault.read(file);
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
	private freshComment(
		content: string,
		comment: Comment,
	): Comment | undefined {
		const parsed = parseAll(content);
		if (comment.id !== undefined) {
			return parsed.find((c) => c.id === comment.id);
		}
		return parsed.find(
			(c) =>
				c.marker.start === comment.marker.start &&
				c.marker.end === comment.marker.end &&
				c.category === comment.category &&
				c.body === comment.body,
		);
	}

	// One message for "the marker this action was aimed at is not there any
	// more". Repeatable once the note catches up, unlike whatever a stale-offset
	// write would have destroyed.
	private noticeVanished(): void {
		new Notice(
			'This comment has moved since it was loaded. Reopen the note and try again.',
		);
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
	// avoids autosave clobber) and falling back to vault.modify otherwise.
	// Always rebuilds the index and fires "index-changed" after the write.
	private async applySplices(
		path: string,
		file: TFile,
		splices: SpliceRange[],
	): Promise<void> {
		if (splices.length === 0) return;

		const view = this.getOpenMarkdownView(path);
		const before = view
			? view.editor.getValue()
			: await this.plugin.app.vault.read(file);

		// Compute updated content by applying splices in reverse so earlier
		// splices do not shift later offsets.
		const sorted = [...splices].sort((a, b) => a.from - b.from);
		let updated = before;
		for (let i = sorted.length - 1; i >= 0; i--) {
			const s = sorted[i];
			if (!s) continue;
			updated = updated.slice(0, s.from) + s.insert + updated.slice(s.to);
		}

		if (view) {
			// Apply via editor.replaceRange in reverse order so earlier
			// splices do not shift later offsets. This is the same API the
			// edit composer uses (composer.ts) and keeps the CodeMirror
			// EditorState authoritative — Obsidian persists the editor's
			// content, so vault.modify is not needed (and would race the
			// editor's autosave).
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
			await this.plugin.app.vault.modify(file, updated);
		}

		this.plugin.commentIndex.rebuild(path, updated);
		this.plugin.events.trigger('index-changed', { path });
	}
}
