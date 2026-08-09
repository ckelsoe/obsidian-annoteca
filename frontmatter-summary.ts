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

export const FM_OPEN = 'annoteca_open';
export const FM_OLDEST_OPEN = 'annoteca_oldest_open';
export const FM_CATEGORIES = 'annoteca_categories';
export const FILECLASS_VALUE = 'annoteca';
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

// Write the summary into the note's frontmatter, only when something changed.
// Preserves every other frontmatter key via processFrontMatter. A no-op when the
// note is not managed or already matches.
export async function applyFrontmatterSummary(
	app: App,
	file: TFile,
	comments: readonly Comment[],
	opts: FrontmatterSummaryOptions,
	shouldContinue?: () => boolean,
): Promise<void> {
	const property =
		opts.fileclassProperty.trim() || DEFAULT_FILECLASS_PROPERTY;
	// Never let the class tag point at a managed summary field; that would make
	// the write fight itself and loop.
	const writeClassTag = opts.writeClassTag && !isReservedProperty(property);
	const cache = app.metadataCache.getFileCache(file);
	const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;

	if (!isManagedNote(comments.length > 0, fm, property)) return;

	const desired = computeSummary(comments, opts);
	if (frontmatterMatches(fm, desired, property, writeClassTag)) return;

	// Bail if the caller (the plugin) has been unloaded since this write was
	// scheduled; do not mutate a note after teardown.
	if (shouldContinue && !shouldContinue()) return;

	await app.fileManager.processFrontMatter(
		file,
		(front: Record<string, unknown>) => {
			front[FM_OPEN] = desired.open;

			if (desired.oldestOpen !== undefined) {
				front[FM_OLDEST_OPEN] = desired.oldestOpen;
			} else {
				delete front[FM_OLDEST_OPEN];
			}

			if (desired.categories !== undefined) {
				front[FM_CATEGORIES] = desired.categories;
			} else {
				delete front[FM_CATEGORIES];
			}

			if (writeClassTag) {
				const merged = mergeFileclass(front[property]);
				if (merged.changed) front[property] = merged.value;
			}
		},
	);
}
