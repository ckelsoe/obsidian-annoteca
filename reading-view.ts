// Reading-view indicator. Annoteca markers are HTML comments, which the
// markdown renderer drops, so in reading view comments are otherwise invisible
// with no hint they exist. This postprocessor re-reads the raw section source
// via getSectionInfo and renders a small indicator: a note-level banner, a
// per-section badge, or both, per the readingViewIndicator setting.

import type { MarkdownPostProcessorContext, MarkdownView } from 'obsidian';
import type AnnotecaPlugin from './main';
import { parseDocument } from './document';
import { toEditorText } from './note-text';
import type { Comment } from './types';
import { forbiddenRanges } from './comment-service';
import {
	collapseWhitespace,
	locateInSource,
	normalizeSelection,
	startsBefore,
} from './reading-selection';

export interface ThreadCounts {
	open: number;
	resolved: number;
}

// Counts comment threads, not replies: a comment with five replies is one
// thread. Resolved and open are reported separately.
export function countThreads(comments: Comment[]): ThreadCounts {
	let open = 0;
	let resolved = 0;
	for (const c of comments) {
		if (c.resolution) {
			resolved += 1;
		} else {
			open += 1;
		}
	}
	return { open, resolved };
}

export function indicatorLabel(counts: ThreadCounts): string {
	const parts: string[] = [];
	if (counts.open > 0) {
		parts.push(`${counts.open} open`);
	}
	if (counts.resolved > 0) {
		parts.push(`${counts.resolved} resolved`);
	}
	return parts.join(' · ');
}

// Char offset of the first character of `line` (0-based) in `content`.
// Returns content.length when the line is past the end.
export function offsetOfLine(content: string, line: number): number {
	let offset = 0;
	for (let i = 0; i < line; i++) {
		const idx = content.indexOf('\n', offset);
		if (idx < 0) {
			return content.length;
		}
		offset = idx + 1;
	}
	return offset;
}

export function registerReadingViewIndicator(plugin: AnnotecaPlugin): void {
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		const mode = plugin.settings.readingViewIndicator;
		if (mode === 'off') {
			return;
		}
		// getSectionInfo returns null for some render contexts (embeds, print);
		// degrade to no indicator rather than guessing at the source.
		const info = ctx.getSectionInfo(el);
		if (!info) {
			return;
		}
		// info.text is the whole note's source; lineStart/lineEnd delimit the
		// section being rendered. One parse serves both the per-section counts
		// and the note-level banner totals. parseDocument, not parseAll: an eof
		// comment's resolution lives in the store, so a lean marker read alone
		// always looks open and the indicator counts would be wrong.
		// Editor offsets, like the index: a click here hands the comment to the
		// hub, which keys its selection on marker.start.
		const text = toEditorText(info.text);
		const all = parseDocument(text).comments;
		if (all.length === 0) {
			return;
		}
		const sectionStart = offsetOfLine(text, info.lineStart);
		const sectionEnd = offsetOfLine(text, info.lineEnd + 1);
		const inSection = all.filter(
			(c) =>
				c.marker.start >= sectionStart && c.marker.start < sectionEnd,
		);

		const open = (comment: Comment) => {
			plugin.openReviewerOnComment(comment, ctx.sourcePath, el);
		};

		// The banner attaches to whichever section hosts the file's first
		// marker: stable across partial re-renders and immune to frontmatter
		// shifting the first section's lineStart away from 0.
		const first = all[0];
		if (
			(mode === 'banner' || mode === 'both') &&
			first !== undefined &&
			first.marker.start >= sectionStart &&
			first.marker.start < sectionEnd
		) {
			const banner = el.createEl('button', {
				text: `Comments in this note: ${indicatorLabel(countThreads(all))}`,
				cls: 'annoteca-rv-indicator annoteca-rv-banner',
			});
			banner.addEventListener('click', () => {
				open(first);
			});
			el.prepend(banner);
		}

		const firstInSection = inSection[0];
		if (
			(mode === 'per-section' || mode === 'both') &&
			firstInSection !== undefined
		) {
			const badge = el.createEl('button', {
				text: indicatorLabel(countThreads(inSection)),
				cls: 'annoteca-rv-indicator annoteca-rv-badge',
			});
			badge.addEventListener('click', () => {
				open(firstInSection);
			});
		}
	});
}

// F-261: comment on text selected in reading view. Each rendered section's
// post-processor context is kept here, keyed by the section's element, so a
// selection can be traced to the source lines that section came from. A
// WeakMap, so a section Obsidian throws away takes its context with it.
const sectionContexts = new WeakMap<
	HTMLElement,
	MarkdownPostProcessorContext
>();

export function registerReadingSelection(plugin: AnnotecaPlugin): void {
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		sectionContexts.set(el, ctx);
	});
}

function sectionFor(node: Node | null): HTMLElement | undefined {
	for (let n: Node | null = node; n !== null; n = n.parentNode) {
		if (n.instanceOf(HTMLElement) && sectionContexts.has(n)) return n;
	}
	return undefined;
}

// The section's rendered text, up to where `range` starts when one is given,
// without Annoteca's own indicator buttons, which reading view adds and the
// source does not hold.
function renderedText(section: HTMLElement, upTo?: Range): string {
	const span = section.ownerDocument.createRange();
	span.selectNodeContents(section);
	if (upTo) span.setEnd(upTo.startContainer, upTo.startOffset);
	const holder = section.ownerDocument.win.createDiv();
	holder.appendChild(span.cloneContents());
	for (const b of Array.from(
		holder.querySelectorAll('.annoteca-rv-indicator'),
	))
		b.remove();
	return holder.textContent ?? '';
}

// The editor-text range a reading-view selection covers, or why there is none.
// Scoped to one rendered section, as getSectionInfo is; repeated text is told
// apart by its order in the section (see reading-selection.ts).
//
// Offsets are into the note as reading view shows it, `view.getViewData()`.
// Not the view's editor: in reading view Obsidian stops keeping that in step
// with the file (seen: a frontmatter write reached the file and the rendered
// note but not the hidden editor). `text` is returned so the caller can load
// it into the editor before using the offsets there.
export function readingSelectionRange(
	view: MarkdownView,
): { from: number; to: number; text: string } | { error: string } {
	const doc = view.containerEl.ownerDocument;
	const selection = doc.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0)
		return { error: 'Select the text to comment on first.' };
	const range = selection.getRangeAt(0);
	if (!view.containerEl.contains(range.commonAncestorContainer))
		return { error: 'Select the text to comment on first.' };
	const section = sectionFor(range.startContainer);
	if (!section || section !== sectionFor(range.endContainer))
		return {
			error: 'Select text within one paragraph or block, then try again.',
		};
	const info = sectionContexts.get(section)?.getSectionInfo(section);
	if (!info)
		return {
			error: 'Annoteca cannot tell where this text is in the note. Comment on it from editing view.',
		};
	const text = toEditorText(view.getViewData());
	// The section's source as the renderer saw it. When the note changed
	// since, offsets into it would land on the wrong words.
	if (toEditorText(info.text) !== text)
		return { error: 'The note just changed. Select the text again.' };
	const sectionStart = offsetOfLine(text, info.lineStart);
	const sectionEnd = offsetOfLine(text, info.lineEnd + 1);
	const selected = selection.toString();
	// Where the selection starts among every place its text starts in the
	// section, overlapping ones included.
	const occurrence = startsBefore(
		collapseWhitespace(renderedText(section)),
		normalizeSelection(selected),
		collapseWhitespace(renderedText(section, range)).length,
	);
	const found = locateInSource(
		text.slice(sectionStart, sectionEnd),
		selected,
		occurrence,
	);
	if (!found)
		return {
			error: 'Annoteca could not match that text to the note. Select plain text within one paragraph, or comment from editing view.',
		};
	const from = sectionStart + found.start;
	const to = sectionStart + found.end;
	if (forbiddenRanges(text).some((f) => f.start < to && f.end > from))
		return {
			error: "That text includes another comment's marker or the note properties. Select text beside it.",
		};
	return { from, to, text };
}
