// No imports, so anything can ask where the properties end.

// The note's frontmatter block, as its end offset, or 0 when it has none. Only
// a block that opens the document counts; a `---` anywhere else is a
// horizontal rule. Shared with forbiddenRanges in forbidden.ts, so the two
// never disagree about where the properties end.
// `---` straight after `---` is an empty properties block, which Obsidian
// still reads as properties. It is tried first: with an optional middle
// instead, the regex took the middle whenever it could, so `---\n---\nBody`
// followed by a later `---` rule ran the properties to that rule.
const FRONTMATTER_RE = /^---\n(?:---|[\s\S]*?\n---)[ \t]*(\n|$)/;

// Kept for the last note asked about: placement asks this many times for one
// note, and large properties were matched afresh each time.
let last: { content: string; end: number } | undefined;
export function frontmatterEnd(content: string): number {
	if (last?.content !== content)
		last = { content, end: FRONTMATTER_RE.exec(content)?.[0].length ?? 0 };
	return last.end;
}
