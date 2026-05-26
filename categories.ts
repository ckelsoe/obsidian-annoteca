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

// Built-in presets the user can browse and cherry-pick categories from. Each
// preset is a curated set of categories for a common writing or review
// workflow. Selecting a preset does not replace the user's working list;
// they choose which categories to add. Custom user-saved presets live in
// settings alongside these.
export interface Preset {
	id: string;
	displayName: string;
	categories: readonly CategoryDefinition[];
}

export const DEFAULT_PRESETS: readonly Preset[] = [
	{
		id: "general",
		displayName: "General editing",
		categories: DEFAULT_CATEGORIES.filter(c => c.id !== "uncategorized"),
	},
	{
		id: "scholarly",
		displayName: "Scholarly / theology",
		categories: [
			{ id: "verse-needed", displayName: "Verse needed", icon: "book", color: "var(--color-cyan)" },
			{ id: "meditation", displayName: "Meditation", icon: "heart", color: "var(--color-pink)" },
			{ id: "exegesis", displayName: "Exegesis", icon: "scroll", color: "var(--color-purple)" },
			{ id: "translation", displayName: "Translation", icon: "languages", color: "var(--color-blue)" },
		],
	},
	{
		id: "fiction",
		displayName: "Fiction writing",
		categories: [
			{ id: "character", displayName: "Character", icon: "user", color: "var(--color-purple)" },
			{ id: "plot", displayName: "Plot", icon: "git-branch", color: "var(--color-blue)" },
			{ id: "pacing", displayName: "Pacing", icon: "timer", color: "var(--color-orange)" },
			{ id: "dialogue", displayName: "Dialogue", icon: "message-circle", color: "var(--color-green)" },
			{ id: "setting", displayName: "Setting", icon: "map-pin", color: "var(--color-yellow)" },
			{ id: "voice", displayName: "Voice", icon: "mic", color: "var(--color-pink)" },
		],
	},
	{
		id: "code-review",
		displayName: "Code review",
		categories: [
			{ id: "security", displayName: "Security", icon: "shield-alert", color: "var(--color-red)" },
			{ id: "performance", displayName: "Performance", icon: "zap", color: "var(--color-orange)" },
			{ id: "style", displayName: "Style", icon: "paintbrush", color: "var(--color-purple)" },
			{ id: "architecture", displayName: "Architecture", icon: "building-2", color: "var(--color-blue)" },
			{ id: "test-coverage", displayName: "Test coverage", icon: "test-tube", color: "var(--color-green)" },
			{ id: "nit", displayName: "Nit", icon: "more-horizontal", color: "var(--text-muted)" },
		],
	},
	{
		id: "project-planning",
		displayName: "Project planning",
		categories: [
			{ id: "blocker", displayName: "Blocker", icon: "alert-octagon", color: "var(--color-red)" },
			{ id: "decision-needed", displayName: "Decision needed", icon: "git-pull-request", color: "var(--color-orange)" },
			{ id: "risk", displayName: "Risk", icon: "alert-triangle", color: "var(--color-yellow)" },
			{ id: "opportunity", displayName: "Opportunity", icon: "lightbulb", color: "var(--color-green)" },
			{ id: "follow-up", displayName: "Follow-up", icon: "arrow-right-circle", color: "var(--color-blue)" },
		],
	},
];

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
