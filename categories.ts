// Category catalog: defaults, the optional scholarly preset, validation, and
// reserved-word checks. No Obsidian dependency.

import type { CategoryDefinition } from "./types";

// Reserved words from data-format.md. These cannot be category names because
// the parser uses them as structural keywords in trailing lines.
export const RESERVED_CATEGORY_NAMES: ReadonlySet<string> = new Set([
	"reply",
	"resolved",
	"id",
	"date",
	"author",
]);

// Category names follow the rule from data-format.md:
// lowercase ASCII letters, digits, dashes; starts with a letter; no trailing
// dash; no consecutive dashes.
const CATEGORY_NAME_RE = /^[a-z](-?[a-z0-9])*$/;

export function isValidCategoryName(name: string): boolean {
	if (!CATEGORY_NAME_RE.test(name)) return false;
	if (RESERVED_CATEGORY_NAMES.has(name)) return false;
	return true;
}

// Default category set shipped with V1 per data-format.md.
export const DEFAULT_CATEGORIES: readonly CategoryDefinition[] = [
	{ id: "tone", displayName: "Tone", icon: "message-square", color: "var(--color-purple)" },
	{ id: "clarify", displayName: "Clarify", icon: "help-circle", color: "var(--color-blue)" },
	{ id: "cut", displayName: "Cut", icon: "scissors", color: "var(--color-red)" },
	{ id: "expand", displayName: "Expand", icon: "expand", color: "var(--color-green)" },
	{ id: "tighten", displayName: "Tighten", icon: "minimize-2", color: "var(--color-orange)" },
	{ id: "source-needed", displayName: "Source needed", icon: "book-open", color: "var(--color-yellow)" },
	{ id: "uncategorized", displayName: "Uncategorized", icon: "circle", color: "var(--text-muted)" },
];

// Optional scholarly preset. Off by default; user enables via settings.
export const SCHOLARLY_PRESET_CATEGORIES: readonly CategoryDefinition[] = [
	{ id: "verse-needed", displayName: "Verse needed", icon: "book", color: "var(--color-cyan)" },
	{ id: "meditation", displayName: "Meditation", icon: "heart", color: "var(--color-pink)" },
];

// V2 adds an `index-entry` category for index-tagging during writing. See
// features.md F-260.
export const INDEX_ENTRY_CATEGORY: CategoryDefinition = {
	id: "index-entry",
	displayName: "Index entry",
	icon: "list",
	color: "var(--text-accent)",
};

// Pure helper that resolves the user's enabled category list given settings
// flags. The result is what the modal dropdown and the per-file sidebar group
// by.
export function resolveEnabledCategories(
	customCategories: readonly CategoryDefinition[],
	scholarlyPresetEnabled: boolean,
): CategoryDefinition[] {
	const merged = new Map<string, CategoryDefinition>();
	for (const c of customCategories) merged.set(c.id, c);
	if (scholarlyPresetEnabled) {
		for (const c of SCHOLARLY_PRESET_CATEGORIES) {
			if (!merged.has(c.id)) merged.set(c.id, c);
		}
	}
	return Array.from(merged.values());
}

// Look up a category definition by id, falling back to a stand-in when the id
// is not in the active set. Views and decorations need a non-null result so
// they can render even when a comment uses a category the user has since
// removed.
export function getCategoryOrFallback(
	id: string,
	categories: readonly CategoryDefinition[],
): CategoryDefinition {
	const found = categories.find(c => c.id === id);
	if (found) return found;
	return {
		id,
		displayName: id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " "),
		icon: "message-circle",
		color: "var(--text-muted)",
	};
}
