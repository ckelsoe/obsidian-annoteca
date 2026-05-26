// Starred tab renderer for the Annoteca hub. Cross-file list of every
// comment whose ID is in settings.starredComments. Most-recently-starred
// first. Click a card to navigate to the comment.

import { setIcon } from "obsidian";

import type AnnotecaPlugin from "./main";
import type { Comment } from "./types";
import { getCategoryOrFallback } from "./categories";
import { resolveSettingsCategories } from "./settings";

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
			const catBadge = head.createSpan({
				cls: `annoteca-reviewer-category annoteca-cat-${def.id}`,
			});
			if (def.icon) {
				const iconEl = catBadge.createSpan({ cls: "annoteca-reviewer-category-icon" });
				setIcon(iconEl, def.icon);
			}
			catBadge.createSpan({ text: def.displayName });

			const starBtn = head.createEl("button", {
				cls: "annoteca-row-star is-starred",
				text: "★",
			});
			starBtn.setAttribute("aria-label", "Unstar");
			starBtn.addEventListener("click", e => {
				e.stopPropagation();
				void this.plugin.toggleStarred(c);
			});

			const fileLine = card.createDiv({ cls: "annoteca-starred-file" });
			fileLine.createSpan({ text: entry.path });

			const body = c.body.length > 160 ? c.body.slice(0, 160) + "…" : c.body;
			card.createDiv({ cls: "annoteca-starred-body", text: body });

			if (c.date || c.author || c.resolution) {
				const meta = card.createDiv({ cls: "annoteca-starred-meta" });
				if (c.resolution) meta.createSpan({ cls: "annoteca-reviewer-state", text: "resolved" });
				if (c.date) meta.createSpan({ text: c.date });
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
