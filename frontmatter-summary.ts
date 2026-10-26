// Projects a small, derived summary of a note's comment state into its
// frontmatter, so Obsidian Bases (and Dataview, and AI work-queues) can filter
// and sort notes by review status. The comments stay in the note body; this is a
// projection, regenerated whenever the note's comments change, never the source
// of truth. Feature request #39.
//
// Bases reads frontmatter and file metadata only, never the note body, so a
// count that lives in a marker is invisible to it. Surfacing the count here is
// the whole point: it is the one place a Base can see.

import type { App, TFile } from 'obsidian';
import type { Comment } from './types';

const FM_OPEN = 'annoteca_open';
const FM_OLDEST_OPEN = 'annoteca_oldest_open';
const FM_CATEGORIES = 'annoteca_categories';
const FILECLASS_VALUE = 'annoteca';
// The class tag is opt-in, and its consumers are the Fileclass plugin and its
// predecessor Metadata Menu (same author), which read a `fileclass` property, so
// that is the default. Configurable for setups that use a different alias.
export const DEFAULT_FILECLASS_PROPERTY = 'fileclass';

// The class-tag property must not collide with a managed summary field, or the
// write would fight itself (append `annoteca` to a value the summary also owns)
// and loop every tick. These three names are reserved.
export function isReservedProperty(name: string): boolean {
	return (
		name === FM_OPEN || name === FM_OLDEST_OPEN || name === FM_CATEGORIES
	);
}

export interface FrontmatterSummaryOptions {
	includeOldestOpen: boolean;
	includeCategories: boolean;
	// Opt-in: also write a class-tag property. The Base dashboard does not need
	// it; it is a convenience for Metadata Menu users. Off by default.
	writeClassTag: boolean;
	// Name of the class-tag property when writeClassTag is on. Defaults to
	// `fileclass`, read by the Fileclass plugin and Metadata Menu; configurable.
	fileclassProperty: string;
}

export interface DesiredSummary {
	open: number;
	oldestOpen?: string; // YYYY-MM-DD
	categories?: string[]; // sorted, unique
}

// A comment is open when it has no resolution. Addressed comments (awaiting
// accept / revise / reject) have no resolution yet, so they count as open, which
// is the intent: they still need the reviewer.
function isOpen(c: Comment): boolean {
	return c.resolution === undefined;
}

export function computeSummary(
	comments: readonly Comment[],
	opts: FrontmatterSummaryOptions,
): DesiredSummary {
	const open = comments.filter(isOpen);
	const summary: DesiredSummary = { open: open.length };
	if (open.length === 0) return summary;

	if (opts.includeOldestOpen) {
		let oldest: string | undefined;
		for (const c of open) {
			if (c.date === undefined) continue;
			if (oldest === undefined || c.date < oldest) oldest = c.date;
		}
		// Store the date only; a full timestamp would churn on every reply.
		if (oldest !== undefined) summary.oldestOpen = oldest.slice(0, 10);
	}

	if (opts.includeCategories) {
		const cats = Array.from(new Set(open.map((c) => c.category))).sort();
		if (cats.length > 0) summary.categories = cats;
	}

	return summary;
}

// fileclass may be absent, a scalar string, or a list. The tag is present when
// the value already carries it in either form.
export function fileclassHasAnnoteca(value: unknown): boolean {
	if (typeof value === 'string') return value === FILECLASS_VALUE;
	if (Array.isArray(value)) return value.includes(FILECLASS_VALUE);
	return false;
}

// Merge the annoteca tag into an existing fileclass value without dropping what
// the user already put there. Returns the new value and whether it changed. An
// unrecognised shape (object, number) is left untouched rather than corrupted.
export function mergeFileclass(value: unknown): {
	value: unknown;
	changed: boolean;
} {
	if (value === undefined || value === null) {
		return { value: FILECLASS_VALUE, changed: true };
	}
	if (typeof value === 'string') {
		if (value === FILECLASS_VALUE) return { value, changed: false };
		return { value: [value, FILECLASS_VALUE], changed: true };
	}
	if (Array.isArray(value)) {
		const list = value as unknown[];
		if (list.includes(FILECLASS_VALUE)) return { value, changed: false };
		return { value: [...list, FILECLASS_VALUE], changed: true };
	}
	return { value, changed: false };
}

function arraysEqual(a: readonly string[], b: unknown): boolean {
	if (!Array.isArray(b) || b.length !== a.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// True when the note's frontmatter already reflects the desired summary, and,
// when the class tag is enabled, already carries it, so there is nothing to
// write. When the class tag is off it plays no part. This is the guard that
// stops a write from looping through the modify event.
export function frontmatterMatches(
	fm: Record<string, unknown>,
	desired: DesiredSummary,
	fileclassProperty: string,
	writeClassTag = true,
): boolean {
	if (fm[FM_OPEN] !== desired.open) return false;

	const curOldest = fm[FM_OLDEST_OPEN];
	if (desired.oldestOpen === undefined) {
		if (curOldest !== undefined) return false;
	} else if (curOldest !== desired.oldestOpen) {
		return false;
	}

	const curCats = fm[FM_CATEGORIES];
	if (desired.categories === undefined) {
		if (curCats !== undefined) return false;
	} else if (!arraysEqual(desired.categories, curCats)) {
		return false;
	}

	// When the class tag is off, its property is not written, so it plays no part
	// in whether a note already matches.
	if (!writeClassTag) return true;

	// The class tag is satisfied when a merge would change nothing: either the tag
	// is already present, or the value is a shape mergeFileclass deliberately
	// leaves alone (a number or object, or a property name that collides with a
	// reserved annoteca_* key). Aligning this guard with the merge is what stops a
	// note whose property can never take the tag from looping a write every tick.
	return !mergeFileclass(fm[fileclassProperty]).changed;
}

// Should Annoteca maintain this note's summary? Yes if it has comments now, or if
// it already carries the summary or the fileclass tag, so a note whose last
// comment was just removed still gets its count zeroed rather than left stale. A
// note that never had a comment is left untouched.
export function isManagedNote(
	hasComments: boolean,
	fm: Record<string, unknown>,
	fileclassProperty: string,
): boolean {
	if (hasComments) return true;
	if (typeof fm[FM_OPEN] === 'number') return true;
	return fileclassHasAnnoteca(fm[fileclassProperty]);
}

// The class-tag property a write targets, and whether the tag is written at all.
// Shared by the writer and by Debug mode's check that the cache has caught up,
// so the two can never disagree about what was written.
export function classTagFor(opts: FrontmatterSummaryOptions): {
	property: string;
	writeClassTag: boolean;
} {
	const property =
		opts.fileclassProperty.trim() || DEFAULT_FILECLASS_PROPERTY;
	// Never let the class tag point at a managed summary field; that would make
	// the write fight itself and loop.
	return {
		property,
		writeClassTag: opts.writeClassTag && !isReservedProperty(property),
	};
}

// Write the summary into the note's frontmatter, only when something changed.
// A no-op when the note is not managed or already matches. Resolves to whether
// it wrote.
//
// The summary's own keys are edited as text (writeSummaryKeys) rather than
// through processFrontMatter. That re-serializes the whole block, so every
// key the user owns came back in Obsidian's style: quotes it did not need were
// dropped, and a script reading `date: "2026-10-26"` as a string got a date
// once it lost its quotes. Text that does not parse as YAML is not written to:
// `parse` (Obsidian's parseYaml) throws on it, and the write is abandoned, as
// processFrontMatter abandoned it.
//
// `readActual`, when given, returns the frontmatter as the file holds it now.
// The metadata cache catches up with a write a moment after it lands, so a
// second update scheduled in that moment saw the old values in the cache and
// wrote the same summary again. A cache that says "out of date" is confirmed
// against the file before anything is written; a cache that says "up to date"
// is trusted, since a lagging cache only ever holds older values.
export async function applyFrontmatterSummary(
	app: App,
	file: TFile,
	comments: readonly Comment[],
	opts: FrontmatterSummaryOptions,
	shouldContinue?: () => boolean,
	readActual?: () => Promise<Record<string, unknown>>,
	parse: (yaml: string) => unknown = () => undefined,
): Promise<boolean> {
	const { property, writeClassTag } = classTagFor(opts);
	const cache = app.metadataCache.getFileCache(file);
	const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;

	if (!isManagedNote(comments.length > 0, fm, property)) return false;

	const desired = computeSummary(comments, opts);
	if (frontmatterMatches(fm, desired, property, writeClassTag)) return false;
	if (readActual) {
		const actual = await readActual();
		if (frontmatterMatches(actual, desired, property, writeClassTag))
			return false;
	}

	// Bail if the caller (the plugin) has been unloaded since this write was
	// scheduled; do not mutate a note after teardown.
	if (shouldContinue && !shouldContinue()) return false;

	await app.vault.process(file, (raw) => {
		const block = frontmatterText(raw);
		if (block !== undefined) parse(block);
		const updated = writeSummaryKeys(raw, desired);
		// And the result: an edit that left the YAML broken is not written.
		const written = frontmatterText(updated);
		if (written !== undefined) parse(written);
		return updated;
	});

	// The class tag is one value in a property the user may own, so it is
	// still merged through processFrontMatter, and only when it is missing.
	if (writeClassTag && mergeFileclass(fm[property]).changed) {
		await app.fileManager.processFrontMatter(
			file,
			(front: Record<string, unknown>) => {
				const merged = mergeFileclass(front[property]);
				if (merged.changed) front[property] = merged.value;
			},
		);
	}
	return true;
}

// A summary key at the start of a line, bare or quoted.
const SUMMARY_KEY_RE = new RegExp(
	`^(["']?)(?:${FM_OPEN}|${FM_OLDEST_OPEN}|${FM_CATEGORIES})\\1[ \t]*:`,
);

// How far a line of a flow value opens brackets (`[`, `{`) net of the ones
// it closes. A quote counts only where a flow item starts (after `[`, `{`,
// `,`, `:` or a space, or at the start of the line); elsewhere `'` and `"`
// are ordinary characters, as in `it's`.
function bracketDepth(line: string): number {
	let depth = 0;
	let quote = '';
	let prev = ' ';
	for (const ch of line) {
		if (quote !== '') {
			if (ch === quote) quote = '';
		} else if ((ch === '"' || ch === "'") && '[{,: \t'.includes(prev))
			quote = ch;
		else if (ch === '#' && ' \t'.includes(prev)) break;
		else if (ch === '[' || ch === '{') depth += 1;
		else if (ch === ']' || ch === '}') depth -= 1;
		prev = ch;
	}
	return depth;
}

// A line that belongs to the value of the key above it: indented, or an item
// of a block list written at the key's own indent.
const VALUE_LINE_RE = /^(?:[ \t]|-[ \t]|-\r?$)/;

// A value written bare when YAML would read it back as this same string, and
// quoted otherwise: a number, a boolean, a null or anything with punctuation.
function scalar(value: string): string {
	return /^[a-z][a-z0-9-]*$/.test(value) &&
		!/^(?:true|false|yes|no|on|off|null|y|n)$/.test(value)
		? value
		: JSON.stringify(value);
}

function summaryLines(desired: DesiredSummary): string[] {
	const out = [`${FM_OPEN}: ${desired.open}`];
	if (desired.oldestOpen !== undefined)
		out.push(`${FM_OLDEST_OPEN}: ${desired.oldestOpen}`);
	if (desired.categories !== undefined) {
		if (desired.categories.length === 0) out.push(`${FM_CATEGORIES}: []`);
		else {
			out.push(`${FM_CATEGORIES}:`);
			for (const c of desired.categories) out.push(`  - ${scalar(c)}`);
		}
	}
	return out;
}

// The frontmatter's YAML, without its `---` lines, or undefined when the note
// has none.
function frontmatterText(raw: string): string | undefined {
	const lines = raw.split('\n');
	if (lines[0]?.replace(/\r$/, '') !== '---') return undefined;
	const close = lines.findIndex(
		(l, i) => i > 0 && /^(?:---|\.\.\.)\r?$/.test(l),
	);
	if (close === -1) return undefined;
	return lines.slice(1, close).join('\n');
}

// `raw` with the summary keys set to `desired` and nothing else changed. A key
// the summary no longer has is removed. The keys keep their place: they go
// where the first of them was, or at the end of the block when none was there.
// A note with no frontmatter gets one holding just the summary.
export function writeSummaryKeys(raw: string, desired: DesiredSummary): string {
	const crlf = raw.includes('\r\n');
	const end = crlf ? '\r' : '';
	const fresh = summaryLines(desired).map((l) => l + end);
	const lines = raw.split('\n');
	const close =
		lines[0]?.replace(/\r$/, '') === '---'
			? lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)\r?$/.test(l))
			: -1;
	if (close === -1) {
		// An opening `---` with no close is properties that do not parse;
		// adding a block above it would only make that worse.
		if (lines[0]?.replace(/\r$/, '') === '---')
			throw new Error('The note properties have no closing ---');
		return [`---${end}`, ...fresh, `---${end}`, ...lines].join('\n');
	}
	const kept: string[] = [];
	let at = -1;
	for (let i = 1; i < close; i++) {
		const line = lines[i] ?? '';
		if (!SUMMARY_KEY_RE.test(line)) {
			kept.push(line);
			continue;
		}
		if (at === -1) at = kept.length;
		// A flow value (`[a,` / `{a: 1,`) runs on until its brackets close.
		// Only a value that starts with one: in a plain value a bracket is
		// an ordinary character.
		const value = line.slice(line.indexOf(':') + 1).trim();
		let depth = /^[[{]/.test(value) ? bracketDepth(value) : 0;
		while (depth > 0 && i + 1 < close) {
			i += 1;
			depth += bracketDepth(lines[i] ?? '');
		}
		// The key's own value lines, and the blank and `#` comment lines
		// among them: those belong to the value when a value line follows
		// (a block scalar can hold blank lines, a list can hold comments).
		for (let j = i + 1; j < close; j++) {
			const next = lines[j] ?? '';
			if (VALUE_LINE_RE.test(next)) {
				i = j;
				continue;
			}
			const trimmed = next.trim();
			if (trimmed !== '' && !trimmed.startsWith('#')) break;
		}
	}
	if (at === -1) at = kept.length;
	kept.splice(at, 0, ...fresh);
	return [lines[0] ?? '---', ...kept, ...lines.slice(close)].join('\n');
}
