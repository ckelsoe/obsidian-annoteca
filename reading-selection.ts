// F-261: comment on text selected in reading view.
//
// Reading view shows rendered text, and a comment has to land on the SOURCE.
// Obsidian gives each rendered section its source line range (getSectionInfo),
// so the search is scoped to one section's source. Within it, the rendered text
// and the source differ by markdown syntax: emphasis markers, link targets,
// wikilink brackets, list and heading prefixes, and Annoteca's own markers,
// which reading view never shows. `visibleText` strips those and keeps, for
// every character it keeps, its offset in the source, so a match in the
// visible text maps straight back to a source range.
//
// Repeated text is told apart by order, not by asking: the selection's
// occurrence among matches in the rendered section (counted by the caller from
// the DOM) is the same occurrence among matches in the visible source text.
//
// Pure: no Obsidian or DOM dependency, so it is testable on its own.

interface Visible {
	// The visible characters, whitespace runs collapsed to one space.
	readonly text: string;
	// map[i] is the source offset of text[i].
	readonly map: readonly number[];
}

// Whether the character at `i` is formatting syntax reading view hides.
// `*` and backticks always are. `_` only at a word edge: snake_case renders
// literally. `~` and `=` only doubled (strikethrough, highlight).
function isFormatting(source: string, i: number): boolean {
	const ch = source.charAt(i);
	if (ch === '*' || ch === '`') return true;
	if (ch === '_') {
		const word = /[\p{L}\p{N}]/u;
		return !(
			word.test(source.charAt(i - 1)) && word.test(source.charAt(i + 1))
		);
	}
	if (ch === '~' || ch === '=')
		return source.charAt(i - 1) === ch || source.charAt(i + 1) === ch;
	return false;
}

// Line-start syntax reading view does not show as text: headings, quotes,
// list bullets and numbers, task boxes.
const LINE_PREFIX =
	/^[ \t]*(?:#{1,6}[ \t]+|(?:>[ \t]?)+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;

export function visibleText(source: string): Visible {
	const chars: string[] = [];
	const map: number[] = [];
	const push = (ch: string, at: number): void => {
		if (/\s/.test(ch)) {
			// Collapse: one space for any run, and none at the very start.
			if (chars.length === 0 || chars[chars.length - 1] === ' ') return;
			chars.push(' ');
			map.push(at);
			return;
		}
		chars.push(ch);
		map.push(at);
	};
	let i = 0;
	let lineStart = true;
	while (i < source.length) {
		if (lineStart) {
			lineStart = false;
			const m = LINE_PREFIX.exec(source.slice(i, i + 64));
			if (m && m[0].length > 0) {
				i += m[0].length;
				continue;
			}
		}
		const ch = source.charAt(i);
		if (ch === '\n') {
			push(' ', i);
			i += 1;
			lineStart = true;
			continue;
		}
		// HTML comments, which include every Annoteca marker and closer.
		if (source.startsWith('<!--', i)) {
			const close = source.indexOf('-->', i + 4);
			i = close === -1 ? source.length : close + 3;
			continue;
		}
		// Embeds show content from elsewhere, not this text.
		if (source.startsWith('![[', i)) {
			const close = source.indexOf(']]', i + 3);
			i = close === -1 ? source.length : close + 2;
			continue;
		}
		if (source.startsWith('[[', i)) {
			const close = source.indexOf(']]', i + 2);
			if (close !== -1) {
				const inner = source.slice(i + 2, close);
				const pipe = inner.indexOf('|');
				const shownFrom = pipe === -1 ? i + 2 : i + 2 + pipe + 1;
				for (let k = shownFrom; k < close; k++)
					push(source.charAt(k), k);
				i = close + 2;
				continue;
			}
		}
		if (ch === '!' && source.charAt(i + 1) === '[') {
			const link = markdownLink(source, i + 1);
			if (link) {
				i = link.end;
				continue;
			}
		}
		if (ch === '[') {
			const link = markdownLink(source, i);
			if (link) {
				for (let k = i + 1; k < link.textEnd; k++)
					pushInline(source, k, push);
				i = link.end;
				continue;
			}
		}
		if (
			ch === '\\' &&
			i + 1 < source.length &&
			source.charAt(i + 1) !== '\n'
		) {
			push(source.charAt(i + 1), i + 1);
			i += 2;
			continue;
		}
		if (isFormatting(source, i)) {
			i += 1;
			continue;
		}
		push(ch, i);
		i += 1;
	}
	// No trailing space: a selection never ends on the collapsed line break.
	if (chars[chars.length - 1] === ' ') {
		chars.pop();
		map.pop();
	}
	return { text: chars.join(''), map };
}

// Link text characters, minus the emphasis inside it.
function pushInline(
	source: string,
	k: number,
	push: (ch: string, at: number) => void,
): void {
	if (!isFormatting(source, k)) push(source.charAt(k), k);
}

// `[text](target)` starting at `open` (the `[`). The text ends at the first
// `]` directly followed by `(`; the target at the matching `)`.
function markdownLink(
	source: string,
	open: number,
): { textEnd: number; end: number } | undefined {
	const textEnd = source.indexOf('](', open + 1);
	if (textEnd === -1) return undefined;
	const lineBreak = source.indexOf('\n', open);
	if (lineBreak !== -1 && lineBreak < textEnd) return undefined;
	const close = source.indexOf(')', textEnd + 2);
	if (close === -1) return undefined;
	return { textEnd, end: close + 1 };
}

// What a selection's text becomes for matching: whitespace collapsed, trimmed.
export function normalizeSelection(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// How many complete matches of `needle` start in `haystack`, non-overlapping,
// left to right: the occurrence index of a selection that comes after it.
export function countMatches(haystack: string, needle: string): number {
	if (needle === '') return 0;
	let n = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return n;
		n += 1;
		from = at + needle.length;
	}
}

// The source range of the `occurrence`-th (0-based) match of the selected
// text in `source`, or undefined when it is not there (the selection crossed
// something the visible text does not model, such as a table cell boundary).
export function locateInSource(
	source: string,
	selected: string,
	occurrence: number,
): { start: number; end: number } | undefined {
	const needle = normalizeSelection(selected);
	if (needle === '') return undefined;
	const { text, map } = visibleText(source);
	let from = 0;
	for (let n = 0; ; n++) {
		const at = text.indexOf(needle, from);
		if (at === -1) return undefined;
		if (n === occurrence) {
			const first = map[at];
			const last = map[at + needle.length - 1];
			if (first === undefined || last === undefined) return undefined;
			return { start: first, end: last + 1 };
		}
		from = at + needle.length;
	}
}
