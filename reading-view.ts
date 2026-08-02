// Reading-view indicator. Annoteca markers are HTML comments, which the
// markdown renderer drops, so in reading view comments are otherwise invisible
// with no hint they exist. This postprocessor re-reads the raw section source
// via getSectionInfo and renders a small indicator: a note-level banner, a
// per-section badge, or both, per the readingViewIndicator setting.

import type AnnotecaPlugin from './main';
import { parseAll } from './parser';
import type { Comment } from './types';

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
		// and the note-level banner totals.
		const all = parseAll(info.text);
		if (all.length === 0) {
			return;
		}
		const sectionStart = offsetOfLine(info.text, info.lineStart);
		const sectionEnd = offsetOfLine(info.text, info.lineEnd + 1);
		const inSection = all.filter(
			(c) =>
				c.marker.start >= sectionStart && c.marker.start < sectionEnd,
		);

		const open = (comment: Comment) => {
			plugin.openReviewerOnComment(comment, ctx.sourcePath);
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
