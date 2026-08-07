// Outline tab renderer for the Annoteca hub. Lists the active file's
// headings with open/resolved comment counts per section. Cursor's
// heading is marked with `.is-current`. Badge clicks navigate to the
// first matching comment in that section.

import { MarkdownView, type App } from 'obsidian';

import type AnnotecaPlugin from './main';
import type { Comment } from './types';

export class OutlineTabRenderer {
	// The path we have already kicked off a deferred-leaf load for, so a failed
	// load or an in-flight one cannot re-trigger every render and loop. Cleared
	// once the leaf resolves to a real MarkdownView (the synchronous path below).
	private deferredAttemptedFor: string | undefined;

	constructor(
		private readonly plugin: AnnotecaPlugin,
		private readonly app: App,
		private readonly requestRerender: () => void,
	) {}

	render(container: HTMLElement): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.renderEmpty(container, 'No file open.');
			return;
		}
		container.createEl('h4', { text: file.basename });

		const cache = this.app.metadataCache.getFileCache(file);
		const headings = cache?.headings ?? [];
		const idx = this.plugin.commentIndex.get(file.path);
		const comments = idx?.comments ?? [];

		if (headings.length === 0) {
			container.createEl('p', {
				text: `No headings. ${comments.length} comment(s) total.`,
				cls: 'annoteca-empty',
			});
			return;
		}

		// Bucket the comments by heading so each count badge can also surface
		// the actual comments it refers to (for click-to-first-comment).
		const commentsByBucket: Comment[][] = headings.map(() => []);
		for (const c of comments) {
			let idxBucket = -1;
			for (let i = 0; i < headings.length; i++) {
				const h = headings[i];
				if (!h) continue;
				if (h.position.start.offset > c.marker.start) break;
				idxBucket = i;
			}
			if (idxBucket >= 0) commentsByBucket[idxBucket]?.push(c);
		}

		// Determine which heading contains the editor's cursor so we can mark
		// that row as "current." Looks up the leaf showing this file directly
		// rather than getActiveViewOfType, which returns null when the hub
		// itself is the active leaf.
		//
		// Shares the plugin's predicate rather than repeating `view.file?.path`,
		// so there is one definition of "the leaf holding this note" instead of
		// two that can drift.
		//
		// A leaf restored from a saved workspace and never activated holds a
		// DeferredView with no `editor`, so this synchronous read cannot see the
		// cursor on the first render. When that is the case, load the leaf once
		// (loadedMarkdownView waits for the buffer to fill) and re-render; the
		// synchronous branch below then marks the heading. Guarded to one attempt
		// per path so a failed load cannot loop.
		const editorLeaf = this.plugin.findMarkdownLeafForPath(file.path);
		let cursorBucket = -1;
		if (editorLeaf?.view instanceof MarkdownView) {
			this.deferredAttemptedFor = undefined;
			const editor = editorLeaf.view.editor;
			const offset = editor.posToOffset(editor.getCursor());
			for (let i = 0; i < headings.length; i++) {
				const h = headings[i];
				if (!h) continue;
				if (h.position.start.offset > offset) break;
				cursorBucket = i;
			}
		} else if (editorLeaf && this.deferredAttemptedFor !== file.path) {
			this.deferredAttemptedFor = file.path;
			void this.plugin
				.ensureLeafLoadedForPath(file.path)
				.then((loaded) => {
					if (loaded) this.requestRerender();
				});
		}

		for (let i = 0; i < headings.length; i++) {
			const h = headings[i];
			if (!h) continue;
			const inBucket = commentsByBucket[i] ?? [];
			const openList = inBucket.filter((c) => !c.resolution);
			const resolvedList = inBucket.filter(
				(c) => c.resolution !== undefined,
			);
			const row = container.createDiv({
				cls: `annoteca-density-row${cursorBucket === i ? ' is-current' : ''}`,
				attr: { 'data-level': String(h.level) },
			});
			row.createSpan({
				cls: 'annoteca-density-heading',
				text: h.heading,
			});
			const counts = row.createSpan({ cls: 'annoteca-density-counts' });

			if (openList.length > 0) {
				const openBadge = counts.createEl('button', {
					cls: 'annoteca-density-open clickable',
					text: `${openList.length} open`,
				});
				openBadge.addEventListener('click', (e) => {
					e.stopPropagation();
					const first = openList[0];
					if (first)
						void this.plugin.navigateToComment(
							file.path,
							first.marker.start,
							first,
						);
				});
			}
			if (resolvedList.length > 0) {
				const resolvedBadge = counts.createEl('button', {
					cls: 'annoteca-density-resolved clickable',
					text: `${resolvedList.length} resolved`,
				});
				resolvedBadge.addEventListener('click', (e) => {
					e.stopPropagation();
					const first = resolvedList[0];
					if (first)
						void this.plugin.navigateToComment(
							file.path,
							first.marker.start,
							first,
						);
				});
			}
			row.addEventListener('click', () => {
				void this.plugin.navigateToOffset(
					file.path,
					h.position.start.offset,
				);
			});
		}
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		container.createEl('p', { text: message, cls: 'annoteca-empty' });
	}
}
