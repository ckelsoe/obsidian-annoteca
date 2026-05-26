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

import { MarkdownView, Notice, TFile } from "obsidian";

import type AnnotecaPlugin from "./main";
import type { Comment, Reply } from "./types";
import { parseAll, serialize, todayISO } from "./parser";

interface SpliceRange { from: number; to: number; insert: string; }

export class CommentService {
	constructor(private readonly plugin: AnnotecaPlugin) {}

	async resolveComment(path: string, comment: Comment): Promise<void> {
		if (comment.resolution) return;
		const author = this.resolvedAuthor();
		const resolved: Comment = {
			...comment,
			resolution: { author, date: todayISO(), note: "" },
		};
		await this.replaceMarker(path, comment, resolved);
		new Notice("Resolved.");
	}

	async reopenComment(path: string, comment: Comment): Promise<void> {
		if (!comment.resolution) return;
		const reopened: Comment = { ...comment, resolution: undefined };
		await this.replaceMarker(path, comment, reopened);
		new Notice("Reopened.");
	}

	async deleteComment(path: string, comment: Comment): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const splice = this.buildDeleteSplice(
			await this.readCurrentContent(file, path),
			comment.marker.start,
			comment.marker.end,
		);
		await this.applySplices(path, file, [splice]);
		new Notice("Deleted.");
	}

	async appendReply(comment: Comment, reply: Reply): Promise<void> {
		const path = this.plugin.app.workspace.getActiveFile()?.path;
		if (!path) return;
		const updated: Comment = {
			...comment,
			replies: [...comment.replies, reply],
		};
		await this.replaceMarker(path, comment, updated);
	}

	// Returns the resolved comments in `path` without modifying the file.
	// Used by the delete-all-resolved command to size its confirmation modal.
	async listResolvedInFile(path: string): Promise<Comment[]> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return [];
		const content = await this.readCurrentContent(file, path);
		return parseAll(content).filter(c => c.resolution !== undefined);
	}

	// Strips every resolved marker from `path` in a single file write. Returns
	// the number of markers removed. Caller is responsible for confirmation
	// and for showing a user-facing Notice.
	async deleteAllResolvedInFile(path: string): Promise<number> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return 0;
		const content = await this.readCurrentContent(file, path);
		const resolved = parseAll(content).filter(c => c.resolution !== undefined);
		if (resolved.length === 0) return 0;

		// Bulk cleanup intent is "tidy the file", not "remove this exact span",
		// so when a marker occupies its own line we also strip the trailing
		// newline to avoid a stranded blank line.
		const splices: SpliceRange[] = [];
		for (const c of resolved) {
			let start = c.marker.start;
			let end = c.marker.end;
			const standsAlone = (start === 0 || content.charAt(start - 1) === "\n")
				&& (end === content.length || content.charAt(end) === "\n");
			if (standsAlone && end < content.length) {
				end += 1;
			} else if (start > 0 && content.charAt(start - 1) === " ") {
				start -= 1;
			}
			splices.push({ from: start, to: end, insert: "" });
		}

		await this.applySplices(path, file, splices);
		return resolved.length;
	}

	// Single funnel for parser.serialize + write + index rebuild +
	// "index-changed" event. Every comment-lifecycle write goes through here so
	// future callers cannot bypass index rebuild or event emission.
	async replaceMarker(path: string, prev: Comment, next: Comment): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const serialized = serialize({
			id: next.id,
			category: next.category,
			body: next.body,
			date: next.date,
			author: next.author,
			anchor: next.anchor,
			replies: next.replies,
			resolution: next.resolution,
		});
		await this.applySplices(path, file, [
			{ from: prev.marker.start, to: prev.marker.end, insert: serialized },
		]);
	}

	resolvedAuthor(): string {
		const tag = this.plugin.settings.authorTag.trim();
		if (this.plugin.settings.enableAuthorTag && tag !== "") return tag;
		return "user";
	}

	// ---- internals -----------------------------------------------------

	private getOpenMarkdownView(path: string): MarkdownView | undefined {
		const leaves = this.plugin.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) return view;
		}
		return undefined;
	}

	// Read the truth that a subsequent write must reconcile with. If the file
	// is open in an editor, the editor's value is the truth (it may have
	// unsaved typing the user expects to keep). Otherwise read from vault.
	private async readCurrentContent(file: TFile, path: string): Promise<string> {
		const view = this.getOpenMarkdownView(path);
		if (view) return view.editor.getValue();
		return this.plugin.app.vault.read(file);
	}

	private buildDeleteSplice(content: string, start: number, end: number): SpliceRange {
		// Drop the marker plus any trailing space introduced by range insertion.
		let from = start;
		const to = end;
		if (from > 0 && content.charAt(from - 1) === " ") from -= 1;
		return { from, to, insert: "" };
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
		const before = view ? view.editor.getValue() : await this.plugin.app.vault.read(file);

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
		this.plugin.events.trigger("index-changed", { path });
	}
}
