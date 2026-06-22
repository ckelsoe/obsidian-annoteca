// Starred tab renderer for the Annoteca hub. Cross-file list of every
// comment whose ID is in settings.starredComments. Most-recently-starred
// first. Click a card to navigate to the comment.

import type AnnotecaPlugin from "./main";
import type { Comment } from "./types";
import { getCategoryOrFallback } from "./categories";
import { resolveSettingsCategories } from "./settings";
import { formatStamp, truncate } from "./view-utils";
import { renderCategoryBadge, renderStarButton } from "./ui-helpers";

export class StarredTabRenderer {
	constructor(private readonly plugin: AnnotecaPlugin) {}

	render(container: HTMLElement): void {
		const ids = new Set(this.plugin.settings.starredComments);
		if (ids.size === 0) {
			this.renderEmpty(container, "No starred comments yet. Hover a comment marker and click the star to add one.");
			return;
		}

		// Walk the entire index and collect every comment whose id is starred.
		// Preserve user's star order (most recently starred first) by indexing
		// by id and walking the starredComments array in reverse.
		const byId = new Map<string, { path: string; comment: Comment }>();
		for (const idx of this.plugin.commentIndex.all()) {
			for (const c of idx.comments) {
				if (c.id && ids.has(c.id)) {
					byId.set(c.id, { path: idx.path, comment: c });
				}
			}
		}

		const ordered: Array<{ path: string; comment: Comment }> = [];
		for (let i = this.plugin.settings.starredComments.length - 1; i >= 0; i--) {
			const id = this.plugin.settings.starredComments[i];
			if (!id) continue;
			const hit = byId.get(id);
			if (hit) ordered.push(hit);
		}

		if (ordered.length === 0) {
			this.renderEmpty(container, "All starred comments are missing from the vault. Use the cleanup command to clear orphans.");
			return;
		}

		const enabled = resolveSettingsCategories(this.plugin.settings);
		const list = container.createDiv({ cls: "annoteca-starred-list" });
		for (const entry of ordered) {
			const c = entry.comment;
			const def = getCategoryOrFallback(c.category, enabled);
			const card = list.createDiv({ cls: "annoteca-starred-card" });

			const head = card.createDiv({ cls: "annoteca-starred-head" });
			renderCategoryBadge(head, def, {
				badge: "annoteca-reviewer-category",
				icon: "annoteca-reviewer-category-icon",
			});

			// Every card here is starred (it is the starred list), so hasId/starred
			// are always true; clicking unstars and the starred-changed event
			// re-renders the list.
			renderStarButton(head, {
				cls: "annoteca-row-star",
				hasId: true,
				starred: true,
				onToggle: () => { void this.plugin.toggleStarred(c); },
			});

			const fileLine = card.createDiv({ cls: "annoteca-starred-file" });
			fileLine.createSpan({ text: entry.path });

			card.createDiv({ cls: "annoteca-starred-body", text: truncate(c.body, 160) });

			if (c.date || c.author || c.resolution) {
				const meta = card.createDiv({ cls: "annoteca-starred-meta" });
				if (c.resolution) meta.createSpan({ cls: "annoteca-reviewer-state", text: "resolved" });
				if (c.date) meta.createSpan({ text: formatStamp(c.date) });
				if (c.author) meta.createSpan({ text: c.author });
			}

			card.addEventListener("click", () => {
				void this.plugin.navigateToComment(entry.path, c.marker.start, c);
			});
		}
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		container.createEl("p", { text: message, cls: "annoteca-empty" });
	}
}
