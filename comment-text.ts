// A comment as Markdown, for the clipboard. Pure, so the format is pinned by
// unit tests rather than by whichever surface happened to copy last.
//
// Markdown rather than plain text because the bodies already are Markdown
// (an agent's reply arrives with headings and lists), and the usual place a
// copied thread goes is another note or another agent, both of which read it.

import { formatStamp } from './view-utils';
import type { Comment } from './types';

// The one part of a window a copy touches. A real Window is one; naming
// only this keeps a test's stand-in honest without asserting it is a Window.
export interface ClipboardWindow {
	navigator: { clipboard: Pick<Clipboard, 'writeText'> };
}

// "> " on every line, so a multi-line passage stays one blockquote.
function quote(text: string): string {
	return text
		.split('\n')
		.map((line) => (line === '' ? '>' : `> ${line}`))
		.join('\n');
}

function headline(parts: (string | undefined)[]): string {
	return parts.filter((p): p is string => p !== undefined).join(' · ');
}

// One comment and everything said about it: the text it is on, the body, the
// addressed and resolution notes, and every reply, oldest first. A section is
// left out when it has nothing in it, never printed empty.
export function commentAsMarkdown(c: Comment, categoryName: string): string {
	const blocks: string[] = [
		headline([
			`**${categoryName}**`,
			c.author,
			c.date === undefined ? undefined : formatStamp(c.date),
		]),
	];
	// A long capture is already shortened with an ellipsis in its middle
	// (buildAnchorFromSelection), so it is quoted exactly as stored.
	if (c.anchor?.text) blocks.push(quote(c.anchor.text));
	if (c.body !== '') blocks.push(c.body);
	if (c.addressed) {
		blocks.push(
			`*Addressed ${formatStamp(c.addressed.date)} by ${c.addressed.author}*`,
		);
		if (c.addressed.note !== '') blocks.push(c.addressed.note);
		if (c.addressed.original !== undefined)
			blocks.push(`Original text:\n\n${quote(c.addressed.original)}`);
	}
	if (c.resolution) {
		blocks.push(
			`*Resolved ${formatStamp(c.resolution.date)} by ${c.resolution.author}*`,
		);
		if (c.resolution.note !== '') blocks.push(c.resolution.note);
	}
	// A blank line after the reply's headline: a single newline would fold
	// the headline into the first paragraph of the reply when it renders.
	for (const r of c.replies)
		blocks.push(
			`${headline([`**${r.author}**`, formatStamp(r.date)])}\n\n${r.body}`,
		);
	return blocks.join('\n\n');
}

// Every comment in a set of notes, one `##` heading per note so a pasted
// digest says where each comment lives. Comments are separated by a rule;
// the order is the caller's, which is the order the hub shows them in.
export function commentsAsMarkdown(
	groups: readonly { path: string; comments: readonly Comment[] }[],
	categoryName: (id: string) => string,
): string {
	return groups
		.filter((g) => g.comments.length > 0)
		.map(
			(g) =>
				`## ${g.path}\n\n` +
				g.comments
					.map((c) => commentAsMarkdown(c, categoryName(c.category)))
					.join('\n\n---\n\n'),
		)
		.join('\n\n');
}
