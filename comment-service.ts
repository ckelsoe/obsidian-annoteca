// Comment lifecycle service. Owns the verbs that mutate a marker in the
// vault and rebuild the in-memory index: resolve / reopen / delete / append
// reply / replace, plus bulk operations and the resolved-author helper.
//
// AnnotecaPlugin keeps thin pass-through methods for the public API so
// external callers (the hub Thread tab, popup handlers) do not break, but
// the actual work lives here. parser.serialize is funneled through
// replaceMarker so future callers cannot bypass index rebuild + event
// emission.

import { Notice, TFile } from "obsidian";

import type AnnotecaPlugin from "./main";
import type { Comment, Reply } from "./types";
import { parseAll, serialize, todayISO } from "./parser";

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
		const content = await this.plugin.app.vault.read(file);
		// Drop the marker plus any trailing space introduced by range insertion.
		let start = comment.marker.start;
		const end = comment.marker.end;
		if (start > 0 && content.charAt(start - 1) === " ") start -= 1;
		const updated = content.slice(0, start) + content.slice(end);
		await this.plugin.app.vault.modify(file, updated);
		this.plugin.commentIndex.rebuild(path, updated);
		this.plugin.events.trigger("index-changed", { path });
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
		const content = await this.plugin.app.vault.read(file);
		return parseAll(content).filter(c => c.resolution !== undefined);
	}

	// Strips every resolved marker from `path` in a single file write. Returns
	// the number of markers removed. Caller is responsible for confirmation
	// and for showing a user-facing Notice.
	async deleteAllResolvedInFile(path: string): Promise<number> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return 0;
		const content = await this.plugin.app.vault.read(file);
		const resolved = parseAll(content).filter(c => c.resolution !== undefined);
		if (resolved.length === 0) return 0;

		// Walk in reverse so earlier splices do not shift later offsets.
		// Mirror deleteComment's leading-space cleanup for inline markers,
		// and also strip the trailing newline when the marker occupies its
		// own line — bulk cleanup intent is "tidy the file", not "remove
		// this exact span", so a stranded blank line would be a surprise.
		let updated = content;
		for (let i = resolved.length - 1; i >= 0; i--) {
			const c = resolved[i];
			if (!c) continue;
			let start = c.marker.start;
			let end = c.marker.end;
			const standsAlone = (start === 0 || updated.charAt(start - 1) === "\n")
				&& (end === updated.length || updated.charAt(end) === "\n");
			if (standsAlone && end < updated.length) {
				end += 1;
			} else if (start > 0 && updated.charAt(start - 1) === " ") {
				start -= 1;
			}
			updated = updated.slice(0, start) + updated.slice(end);
		}

		await this.plugin.app.vault.modify(file, updated);
		this.plugin.commentIndex.rebuild(path, updated);
		this.plugin.events.trigger("index-changed", { path });
		return resolved.length;
	}

	// Single funnel for parser.serialize + vault.modify + index rebuild +
	// "index-changed" event. Every comment-lifecycle write goes through here so
	// future callers cannot bypass index rebuild or event emission.
	async replaceMarker(path: string, prev: Comment, next: Comment): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const content = await this.plugin.app.vault.read(file);
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
		const updated = content.slice(0, prev.marker.start) + serialized + content.slice(prev.marker.end);
		await this.plugin.app.vault.modify(file, updated);
		this.plugin.commentIndex.rebuild(path, updated);
		this.plugin.events.trigger("index-changed", { path });
	}

	resolvedAuthor(): string {
		const tag = this.plugin.settings.authorTag.trim();
		if (this.plugin.settings.enableAuthorTag && tag !== "") return tag;
		return "user";
	}
}
