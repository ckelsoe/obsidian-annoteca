// The one boundary between a note's stored bytes and the text every offset in
// this plugin refers to.
//
// Offsets mean editor offsets everywhere: marker clicks, the cursor, the hub's
// selection and navigation all come from the CodeMirror buffer. CodeMirror
// splits on \r\n, \r and \n and joins with \n, so a note saved with Windows line
// endings is one character shorter per line in the editor than on disk. The
// vault hands back the stored bytes. Every site that did offset maths used to
// reconcile the two on its own, and most did not, which is how Windows notes
// broke one site at a time.
//
// So nothing outside this module converts line endings or maps an offset. Code
// reads a note as a NoteText, does all of its work on `text`, and writes back
// through `spliceRaw`, which maps each splice into the stored bytes and gives
// inserted text the ending of the line it lands in. Bytes outside the splices are
// left alone, so a note with mixed endings keeps its other lines as they were.
// Normalizing the whole file and re-applying one ending would be simpler, and
// would hand every sync client a whole-file change for a one-line edit.
//
// Pure: no Obsidian dependency, so it is testable on its own.

import type { SpliceRange } from './store';

type LineEnding = '\n' | '\r\n' | '\r';

export interface NoteText {
	// The bytes as stored.
	readonly raw: string;
	// What every offset refers to: `raw` with each line break turned into \n.
	readonly text: string;
	// Maps an offset into `text` to the matching offset into `raw`. An offset at
	// a line break maps to the start of that break, never between \r and \n.
	toRaw(offset: number): number;
	// The line ending text written at `offset` should use: the ending of the line
	// `offset` sits on, or of the last line when that one has none. \n for a note
	// with no line breaks at all.
	endingAt(offset: number): LineEnding;
}

// CodeMirror's reading of a note. Exported for the callers that only need the
// text, not the mapping back (the index, reading view, diagnostics).
export function toEditorText(content: string): string {
	return content.includes('\r') ? content.replace(/\r\n?/g, '\n') : content;
}

export function noteText(raw: string): NoteText {
	const text = toEditorText(raw);
	// The editor offsets where a \r\n pair was collapsed to one \n, ascending.
	// A lone \r becomes \n one for one, so it shifts nothing and is not listed.
	const collapsed: number[] = [];
	if (text.length !== raw.length) {
		let editor = 0;
		for (let i = 0; i < raw.length; i++, editor++) {
			if (raw.charCodeAt(i) === 13 && raw.charCodeAt(i + 1) === 10) {
				collapsed.push(editor);
				i++;
			}
		}
	}
	// How many collapsed pairs sit strictly before `offset`, by binary search.
	const shiftBefore = (offset: number): number => {
		let lo = 0;
		let hi = collapsed.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if ((collapsed[mid] ?? Infinity) < offset) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	const toRaw =
		collapsed.length === 0
			? (offset: number) => offset
			: (offset: number) => offset + shiftBefore(offset);
	return {
		raw,
		text,
		toRaw,
		endingAt: (offset) => endingAt(raw, toRaw(offset)),
	};
}

function endingAt(raw: string, from: number): LineEnding {
	for (let i = from; i < raw.length; i++) {
		const ch = raw.charCodeAt(i);
		if (ch === 10) return '\n';
		if (ch === 13) return raw.charCodeAt(i + 1) === 10 ? '\r\n' : '\r';
	}
	for (let i = Math.min(from, raw.length) - 1; i >= 0; i--) {
		const ch = raw.charCodeAt(i);
		if (ch === 13) return '\r';
		if (ch === 10) return raw.charCodeAt(i - 1) === 13 ? '\r\n' : '\n';
	}
	return '\n';
}

// Applies splices given in `text` offsets to `raw`, returning the new stored
// bytes. Line breaks in each insert take the ending of the line the splice
// starts on. The splices must not overlap; their order does not matter.
export function spliceRaw(
	note: NoteText,
	splices: readonly SpliceRange[],
): string {
	const mapped = splices
		.map((s) => {
			const ending = note.endingAt(s.from);
			const insert = toEditorText(s.insert);
			return {
				from: note.toRaw(s.from),
				to: note.toRaw(s.to),
				insert:
					ending === '\n' ? insert : insert.replace(/\n/g, ending),
			};
		})
		.sort((a, b) => a.from - b.from);
	let out = note.raw;
	for (let i = mapped.length - 1; i >= 0; i--) {
		const s = mapped[i];
		if (!s) continue;
		out = out.slice(0, s.from) + s.insert + out.slice(s.to);
	}
	return out;
}
