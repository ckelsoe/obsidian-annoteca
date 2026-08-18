// Encode and decode for the end-of-file comment store (issue #48, "keep prose
// clean" storage). No Obsidian dependency, and — unlike parser.ts — no dependency
// on the marker grammar either: a store entry is a self-contained JSON object
// wrapped in one HTML comment, so the only thing it shares with the marker format
// is the Comment model it serializes.
//
// WHY JSON, AND WHY THIS IS SIMPLER THAN THE MARKER FORMAT.
// The inline marker format is a hand-rolled single-line bracket grammar, so it
// carries a lot of escape machinery (escapeTerminator, escapeOpener,
// escapeStructuredLine, the backslash-run bijection) to survive arbitrary user
// text, and it is lossy by contract (line breaks in inline fields collapse, the
// anchor is capped, a body line that mimics a trailing line is absorbed). The
// store side has none of that: JSON already encodes newlines, quotes, brackets,
// backslashes and unicode losslessly, so a comment round-trips through the store
// BYTE FOR BYTE on every field, including a multi-line reply the marker cannot
// hold.
//
// THE ONE WRAPPER HAZARD, AND ITS FIX.
// The JSON sits inside `<!-- annoteca:store ... -->`, so an HTML-comment delimiter
// (`-->`, which closes the wrapper, or `<!--`, which opens a nested one) appearing
// inside a JSON string value would break the entry. JSON.stringify does NOT escape
// `<` or `>`, so a body of `a-->b` stringifies to the literal `"a-->b"`.
//
// The fix is exact and needs no bijection: `<` and `>` never appear in JSON
// STRUCTURAL syntax (the tokens are `{}[]:,"` , whitespace, and the literals
// true/false/null/numbers), so they can only occur inside string values.
// Replacing every `<` with `\u003c` and every `>` with `\u003e` in the stringified
// JSON therefore (a) touches only string content, (b) is still valid JSON, and
// (c) is decoded straight back to `<`/`>` by JSON.parse. After the replacement the
// payload provably contains no `<` and no `>` at all, so it cannot contain `<!--`
// or `-->`: the first `-->` after the opener is always the real terminator, and a
// store entry can never nest an opener. That is what lets scanStoreEntries pair
// with a plain lazy regex, with none of scanMarkers' nested-opener walk.
//
// FAILURE ISOLATION. One HTML comment per entry, per the design in
// dev-docs/annoteca/2026-08-09-eof-comment-store-design.md. A single malformed
// entry (a hand edit, an older tool, an assistant that wrote a raw `-->`) fails to
// parse and is dropped by decode, quarantining itself; every other entry in the
// file is untouched. A single fenced JSON block holding all comments would fail
// atomically instead.

import type {
	AnchorText,
	Addressed,
	Comment,
	Reply,
	Resolution,
} from './types';

// Schema version stamped into every entry. The marker format deliberately has NO
// version sentinel (see parser.ts's escapeTerminator note: adding one there is a
// breaking change against a corruption bug). The store is greenfield, so it can
// afford the sentinel it costs nothing to add now and everything to retrofit
// later: a future schema change reads `v` and migrates, rather than guessing the
// shape from the keys present.
export const STORE_SCHEMA_VERSION = 1;

// The opener carries `annoteca:store` (colon), distinct from a marker's
// `annoteca/<category>:` (slash). MARKER_RE requires the slash, so the marker
// scanner never matches a store entry and this scanner never matches a marker;
// the two grammars share a file without colliding.
const STORE_OPENER = '<!-- annoteca:store';
const STORE_TERMINATOR = '-->';
// Lazy, and safe to be lazy: neutralizeAngles guarantees the JSON payload holds no
// `>`, so the first `-->` after an opener is the terminator. `[\s\S]` rather than
// `.` so the multi-line pretty JSON is matched across its newlines.
const STORE_ENTRY_RE = /<!--\s*annoteca:store\b([\s\S]*?)-->/g;

// The persistable shape of a comment: everything except the marker's byte range,
// which is positional and recomputed on parse. `id` is REQUIRED — it is the key
// that joins a store entry back to its lean inline marker, so a comment with no id
// cannot live in the store. Replies default to empty; every other field is absent
// when unset, never null.
export interface StoredComment {
	id: string;
	category: string;
	body: string;
	date?: string;
	author?: string;
	anchor?: AnchorText;
	replies: readonly Reply[];
	addressed?: Addressed;
	resolution?: Resolution;
	// Forward-compatibility channel for trailing lines a version does not
	// understand, carried verbatim exactly as the marker format carries them, so a
	// fold between storage modes never drops them. See parser.ts's unknown-line
	// branch.
	unknownLines?: readonly string[];
}

export interface RawStoreEntry {
	start: number; // byte offset of the leading `<` of `<!--`
	end: number; // one past the trailing `>` of `-->`
	json: string; // inner text between opener and terminator (before JSON.parse)
}

export interface LocatedStoreEntry {
	comment: StoredComment;
	start: number;
	end: number;
}

function neutralizeAngles(json: string): string {
	// Order does not matter: the two replacements target disjoint characters and
	// neither can manufacture the other's target (`\u003c` / `\u003e` contain no
	// bare `<` or `>`). Applied to already-stringified JSON, so it only ever lands
	// inside string values.
	return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

// Build the JSON object in a FIXED key order, omitting absent fields. Fixed order
// makes the output deterministic (stable git diffs, and a genuine fixed point for
// the round-trip test); omitting absent fields keeps entries compact and mirrors
// the marker format, which writes no line for a field it does not have.
function buildPayload(c: StoredComment): Record<string, unknown> {
	const out: Record<string, unknown> = {
		v: STORE_SCHEMA_VERSION,
		id: c.id,
		category: c.category,
		body: c.body,
	};
	if (c.date !== undefined) out.date = c.date;
	if (c.author !== undefined) out.author = c.author;
	if (c.anchor !== undefined) {
		out.anchor = { text: c.anchor.text, truncated: c.anchor.truncated };
	}
	const replies = c.replies ?? [];
	if (replies.length > 0) {
		out.replies = replies.map((r) => ({
			author: r.author,
			date: r.date,
			body: r.body,
		}));
	}
	if (c.addressed !== undefined) {
		const a: Record<string, unknown> = {
			author: c.addressed.author,
			date: c.addressed.date,
			note: c.addressed.note,
		};
		// original is absent (never addressed with a prose replacement) or a
		// verbatim string; an empty string is a real original and is kept.
		if (c.addressed.original !== undefined) {
			a.original = c.addressed.original;
		}
		out.addressed = a;
	}
	if (c.resolution !== undefined) {
		out.resolution = {
			author: c.resolution.author,
			date: c.resolution.date,
			note: c.resolution.note,
		};
	}
	if (c.unknownLines !== undefined && c.unknownLines.length > 0) {
		out.unknownLines = [...c.unknownLines];
	}
	return out;
}

// Serialize one comment to a complete store block, ready to splice into the EOF
// region. The caller guarantees a non-empty id (the join key); this does not
// throw on a bad one, matching the marker write path's rule that a serializer must
// never take the whole write down — a bad entry is caught on decode instead.
export function encodeStoreEntry(c: StoredComment): string {
	const json = JSON.stringify(buildPayload(c), null, 2);
	return `${STORE_OPENER}\n${neutralizeAngles(json)}\n${STORE_TERMINATOR}`;
}

// A non-empty string, or undefined. The JSON is user-reachable (hand edits, sync,
// an assistant), so every field is vetted rather than trusted: a value of the
// wrong type does not throw, it fails the whole entry to undefined, which
// quarantines it.
function optString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function coerceAnchor(value: unknown): AnchorText | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const obj = value as Record<string, unknown>;
	const text = optString(obj.text);
	if (text === undefined) return undefined;
	return { text, truncated: obj.truncated === true };
}

// A reply requires author, date and body all present as strings; a malformed one
// drops the whole entry rather than a silent partial thread.
function coerceReplies(value: unknown): Reply[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: Reply[] = [];
	for (const item of value) {
		if (typeof item !== 'object' || item === null) return undefined;
		const obj = item as Record<string, unknown>;
		const author = optString(obj.author);
		const date = optString(obj.date);
		const body = optString(obj.body);
		if (author === undefined || date === undefined || body === undefined) {
			return undefined;
		}
		out.push({ author, date, body });
	}
	return out;
}

function coerceAddressed(value: unknown): Addressed | undefined | null {
	// null is the "field absent" signal; undefined is "field present but
	// malformed", which the caller turns into a whole-entry reject.
	if (value === undefined) return null;
	if (typeof value !== 'object' || value === null) return undefined;
	const obj = value as Record<string, unknown>;
	const author = optString(obj.author);
	const date = optString(obj.date);
	const note = optString(obj.note);
	if (author === undefined || date === undefined || note === undefined) {
		return undefined;
	}
	const addressed: Addressed = { author, date, note };
	if (obj.original !== undefined) {
		const original = optString(obj.original);
		if (original === undefined) return undefined;
		addressed.original = original;
	}
	return addressed;
}

function coerceResolution(value: unknown): Resolution | undefined | null {
	if (value === undefined) return null;
	if (typeof value !== 'object' || value === null) return undefined;
	const obj = value as Record<string, unknown>;
	const author = optString(obj.author);
	const date = optString(obj.date);
	const note = optString(obj.note);
	if (author === undefined || date === undefined || note === undefined) {
		return undefined;
	}
	return { author, date, note };
}

function coerceUnknownLines(value: unknown): string[] | undefined | null {
	if (value === undefined) return null;
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') return undefined;
		out.push(item);
	}
	return out;
}

// Decode one entry's inner JSON to a StoredComment, or undefined when it is not a
// well-formed entry. Invalid JSON, a missing or empty id/category/body, or any
// field of the wrong type all reject the whole entry — the failure-isolation
// contract: a bad entry is dropped, never partially trusted.
//
// `v` is read but not gated: an entry from a FUTURE schema still decodes on its
// known fields rather than being discarded, matching the marker format's rule that
// a version must not throw away what a newer one wrote. (Unknown TOP-LEVEL keys a
// future version adds are not yet carried through a rewrite; schema growth bumps
// `v` and adds a migration. Documented so it is a decision, not a surprise.)
export function decodeStoreEntry(json: string): StoredComment | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const obj = parsed as Record<string, unknown>;

	const id = optString(obj.id);
	const category = optString(obj.category);
	const body = optString(obj.body);
	// id and category are structural; an empty id cannot join to a marker and an
	// empty category cannot render, so both must be non-empty. body may be empty.
	if (id === undefined || id === '') return undefined;
	if (category === undefined || category === '') return undefined;
	if (body === undefined) return undefined;

	const anchor =
		obj.anchor === undefined ? undefined : coerceAnchor(obj.anchor);
	if (obj.anchor !== undefined && anchor === undefined) return undefined;

	const replies = obj.replies === undefined ? [] : coerceReplies(obj.replies);
	if (replies === undefined) return undefined;

	const addressed = coerceAddressed(obj.addressed);
	if (addressed === undefined) return undefined;

	const resolution = coerceResolution(obj.resolution);
	if (resolution === undefined) return undefined;

	const unknownLines = coerceUnknownLines(obj.unknownLines);
	if (unknownLines === undefined) return undefined;

	const out: StoredComment = { id, category, body, replies };
	const date = optString(obj.date);
	if (date !== undefined) out.date = date;
	const author = optString(obj.author);
	if (author !== undefined) out.author = author;
	if (anchor !== undefined) out.anchor = anchor;
	if (addressed !== null) out.addressed = addressed;
	if (resolution !== null) out.resolution = resolution;
	if (unknownLines !== null && unknownLines.length > 0) {
		out.unknownLines = unknownLines;
	}
	return out;
}

// Find every store block in a document, in file order, without decoding. The
// scanner pairs on the guaranteed-clean terminator (neutralizeAngles removed every
// `>` from the payload), so a plain lazy regex is correct — no nested-opener walk.
export function scanStoreEntries(content: string): RawStoreEntry[] {
	const out: RawStoreEntry[] = [];
	STORE_ENTRY_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = STORE_ENTRY_RE.exec(content)) !== null) {
		const json = match[1];
		if (json === undefined) continue;
		out.push({
			start: match.index,
			end: match.index + match[0].length,
			json,
		});
	}
	return out;
}

// Scan and decode in one pass, dropping malformed entries. Returns each surviving
// comment with the byte range of its block, so a caller can rewrite the store
// region in place. Malformed entries are silently skipped here; surfacing them is
// the diagnostics layer's job (a later step generalizes orphan detection to
// stranded entries and dangling markers).
export function parseStore(content: string): LocatedStoreEntry[] {
	const out: LocatedStoreEntry[] = [];
	for (const raw of scanStoreEntries(content)) {
		const comment = decodeStoreEntry(raw.json);
		if (comment === undefined) continue;
		out.push({ comment, start: raw.start, end: raw.end });
	}
	return out;
}

// Replace a document's entire end-of-file store region with exactly `entries`, in
// the given order. This is the one write-side primitive the eof persist funnel
// uses: a mutation recomputes the full desired entry set and calls this, so the
// region is always a clean rebuild rather than a series of surgical per-entry
// edits.
//
// IDEMPOTENT BY CONSTRUCTION, which is what stops the modify-event write loop and
// keeps git from churning. Every store block is stripped wherever it sits, the
// trailing whitespace the region owned is trimmed, and the region is re-emitted at
// EOF in one fixed shape, so writeStoreRegion(writeStoreRegion(x, e), e) equals
// writeStoreRegion(x, e). Stripping blocks from anywhere also relocates a
// hand-moved entry back to the EOF region rather than leaving it stranded mid
// prose.
//
// The caller invokes this only when maintaining an eof-mode file. As a guard, a
// no-op (no existing blocks and no entries) returns the content untouched, so a
// stray call on a plain inline file cannot normalize its trailing whitespace.
export function writeStoreRegion(
	content: string,
	entries: readonly StoredComment[],
): string {
	const blocks = scanStoreEntries(content);
	if (blocks.length === 0 && entries.length === 0) return content;

	// Blocks this version cannot decode (a hand edit, a sync conflict, an entry
	// from a future schema) are carried through the rebuild VERBATIM rather than
	// dropped. The rule is keyed on decode failure, not on absence from `entries`:
	// an intentional delete still removes a decodable entry, while a quarantined
	// one is preserved. Dropping them here would delete a stranded entry's body,
	// thread and history on an unrelated write to the same note, which is the
	// opposite of the failure-isolation contract this file promises.
	const carried = blocks
		.filter((b) => decodeStoreEntry(b.json) === undefined)
		.map((b) => content.slice(b.start, b.end));

	// Remove every store block back to front, so an earlier block's range is not
	// shifted by a later block's removal.
	let prose = content;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (block === undefined) continue;
		prose = prose.slice(0, block.start) + prose.slice(block.end);
	}
	// The region always followed the prose, so after the blocks are gone every
	// trailing character is whitespace the region owned. Trimming it is what makes
	// the rebuild a fixed point. trimEnd() rather than a `\s+$` regex, which the
	// scorecard flags as super-linear backtracking; the two strip the same
	// trailing whitespace here.
	prose = prose.trimEnd();

	// Decodable entries first (current, ordered by the caller), then any carried
	// undecodable blocks. This is a fixed point: a carried block still fails to
	// decode on the next scan and is carried again in the same place.
	const region = [...entries.map(encodeStoreEntry), ...carried];
	if (region.length === 0) {
		return prose === '' ? '' : `${prose}\n`;
	}
	const joined = region.join('\n\n');
	return prose === '' ? `${joined}\n` : `${prose}\n\n${joined}\n`;
}

// ---- write helpers shared by the persist funnel and the composer ----------

// A full comment reduced to its persistable store shape. `id` is passed
// explicitly (it is the store's REQUIRED join key and is always known on the eof
// path) so an entry can never be emitted without one. Empty unknownLines are
// dropped to undefined, matching encodeStoreEntry's omit-when-absent rule.
export function toStored(id: string, c: Comment): StoredComment {
	return {
		id,
		category: c.category,
		body: c.body,
		date: c.date,
		author: c.author,
		anchor: c.anchor,
		replies: c.replies,
		addressed: c.addressed,
		resolution: c.resolution,
		unknownLines: c.unknownLines.length > 0 ? c.unknownLines : undefined,
	};
}

// A minimal edit as a single contiguous replacement range.
export interface SpliceRange {
	from: number;
	to: number;
	insert: string;
}

// The single splice that turns `before` into `after`: shared prefix and suffix
// trimmed to the smallest changed run. Every store write touches one contiguous
// region that sits after all prose (a mutated entry, a dropped one, or a new one
// appended at EOF), so one minimal splice always suffices: the editor path never
// rewrites untouched prose or collapses unrelated undo history, and a
// marker-deletion or marker-recategorize splice stays disjoint from it. Returns
// undefined when nothing changed. charCodeAt comparison keeps this linear; no
// regex, so no scorecard super-linear-backtracking risk.
export function diffToSplice(
	before: string,
	after: string,
): SpliceRange | undefined {
	if (before === after) return undefined;
	let prefix = 0;
	const shortest = Math.min(before.length, after.length);
	while (
		prefix < shortest &&
		before.charCodeAt(prefix) === after.charCodeAt(prefix)
	)
		prefix++;
	let suffix = 0;
	const rest = Math.min(before.length - prefix, after.length - prefix);
	while (
		suffix < rest &&
		before.charCodeAt(before.length - 1 - suffix) ===
			after.charCodeAt(after.length - 1 - suffix)
	)
		suffix++;
	return {
		from: prefix,
		to: before.length - suffix,
		insert: after.slice(prefix, after.length - suffix),
	};
}
