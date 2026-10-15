// F-261: comment on text selected in reading view.
//
// Reading view shows rendered text, and a comment has to land on the SOURCE.
// Obsidian gives each rendered section its source line range (getSectionInfo),
// so the search is scoped to one section's source. Within it, the rendered text
// and the source differ by markdown syntax: emphasis markers, link targets,
// wikilink brackets, list and heading prefixes, HTML tags and entities, and
// Annoteca's own markers, which reading view never shows. `visibleText` strips
// those and keeps, for every character it keeps, the source span it came from,
// so a match in the visible text maps straight back to a source range.
//
// Repeated text is told apart by position, not by asking: the selection's
// index among every place the text starts in the rendered section (overlapping
// ones included, so the last "ana" of "banana" is the second) is the same index
// among the places it starts in the visible source text.
//
// Pure: no Obsidian or DOM dependency, so it is testable on its own.

interface Visible {
	// The visible characters, whitespace runs collapsed to one space.
	readonly text: string;
	// text[i] came from source[starts[i], ends[i]). One character can stand
	// for several (an entity such as `&amp;`).
	readonly starts: readonly number[];
	readonly ends: readonly number[];
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

// An HTML tag, opening or closing. The renderer shows neither it nor its
// attributes.
const HTML_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?>/;

// The entities a note is likely to hold, and numeric ones. Anything else is
// left as typed, which at worst fails to match and is refused.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};
const ENTITY = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/;

function decodeEntity(
	source: string,
	i: number,
): { ch: string; length: number } | undefined {
	const m = ENTITY.exec(source.slice(i, i + 12));
	if (!m) return undefined;
	const [whole, dec, hex, name] = m;
	let ch: string | undefined;
	if (dec !== undefined) ch = String.fromCodePoint(Number(dec));
	else if (hex !== undefined)
		ch = String.fromCodePoint(Number.parseInt(hex, 16));
	else if (name !== undefined) ch = NAMED_ENTITIES[name];
	return ch === undefined ? undefined : { ch, length: whole.length };
}

export function visibleText(source: string): Visible {
	const chars: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	const push = (ch: string, at: number, end = at + 1): void => {
		if (/\s/.test(ch)) {
			// Collapse: one space for any run, and none at the very start.
			if (chars.length === 0 || chars[chars.length - 1] === ' ') return;
			ch = ' ';
		}
		chars.push(ch);
		starts.push(at);
		ends.push(end);
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
		if (ch === '<') {
			const tag = HTML_TAG.exec(source.slice(i, i + 512));
			if (tag) {
				i += tag[0].length;
				continue;
			}
		}
		if (ch === '&') {
			const entity = decodeEntity(source, i);
			if (entity) {
				push(entity.ch, i, i + entity.length);
				i += entity.length;
				continue;
			}
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
					if (!isFormatting(source, k)) push(source.charAt(k), k);
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
		starts.pop();
		ends.pop();
	}
	return { text: chars.join(''), starts, ends };
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

// Whitespace runs to one space, as visibleText does, with nothing leading.
// Applied the same way to the rendered section and to the part of it before
// the selection, so a position in one is a position in the other.
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trimStart();
}

// What a selection's text becomes for matching: whitespace collapsed, trimmed.
export function normalizeSelection(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// How many places `needle` starts in `haystack` before `before`, overlapping
// ones included: the selection's index among them, when the selection starts
// at `before`.
export function startsBefore(
	haystack: string,
	needle: string,
	before: number,
): number {
	if (needle === '') return 0;
	let n = 0;
	for (
		let at = haystack.indexOf(needle);
		at !== -1 && at < before;
		at = haystack.indexOf(needle, at + 1)
	)
		n += 1;
	return n;
}

// The source range of the `occurrence`-th (0-based, overlapping ones counted)
// place the selected text starts in `source`, or undefined when it is not there
// (the selection crossed something the visible text does not model, such as a
// table cell boundary).
export function locateInSource(
	source: string,
	selected: string,
	occurrence: number,
): { start: number; end: number } | undefined {
	const needle = normalizeSelection(selected);
	if (needle === '') return undefined;
	const { text, starts, ends } = visibleText(source);
	let at = text.indexOf(needle);
	for (let n = 0; at !== -1; n++) {
		if (n === occurrence) {
			const start = starts[at];
			const end = ends[at + needle.length - 1];
			if (start === undefined || end === undefined) return undefined;
			return { start, end };
		}
		at = text.indexOf(needle, at + 1);
	}
	return undefined;
}
