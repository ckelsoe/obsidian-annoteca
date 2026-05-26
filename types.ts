// Shared types for the Annoteca plugin. No Obsidian dependency.

export interface Reply {
	author: string;
	date: string; // ISO YYYY-MM-DD
	body: string;
}

export interface Resolution {
	author: string;
	date: string; // ISO YYYY-MM-DD
	note: string; // may be empty
}

export interface MarkerRange {
	start: number; // byte offset of leading `<` of `<!--`
	end: number;   // byte offset one past the trailing `>` of `-->`
}

export interface AnchorText {
	text: string;       // the captured commented text; up to 80 chars
	truncated: boolean; // true when the original selection was longer than 80 chars
}

export interface Comment {
	id: string | undefined;          // 8-char base36 when present
	category: string;                 // matches /^[a-z](-?[a-z0-9])*$/
	body: string;                     // freeform inline markdown
	date: string | undefined;         // ISO YYYY-MM-DD
	author: string | undefined;       // short author tag
	anchor: AnchorText | undefined;   // commented text captured at creation; undefined for cursor-position comments
	replies: Reply[];                 // chronological, oldest first
	resolution: Resolution | undefined;
	marker: MarkerRange;
}

// Used by views.ts when listing vault-wide comments alongside their host file.
export interface LocatedComment {
	path: string;
	comment: Comment;
}

export type AnchorTier = "subtle" | "normal" | "strong";

export interface CategoryDefinition {
	id: string;             // dash-separated lowercase, matches parser rule
	displayName: string;    // sentence case for UI
	icon?: string;          // Obsidian icon name; falls back to category default
	color?: string;         // CSS variable name or hex; falls back to theme variable
	tier?: AnchorTier;      // anchor-underline urgency; undefined === "normal"
}

// User-saved preset. Stored in settings alongside the built-in presets in
// categories.ts. Built-ins are read-only; user-saved ones can be loaded,
// renamed, deleted.
export interface UserPreset {
	id: string;             // generated unique id
	displayName: string;
	categories: CategoryDefinition[];
}

export interface AnnotecaSettings {
	categories: CategoryDefinition[];
	defaultCategory: string;
	enableScholarlyPreset: boolean;
	enableIndexEntryPreset: boolean;

	// "icon"      → inline marker glyph only
	// "underline" → category-tinted anchor underline only (for comments that
	//               were created with a selection)
	// "both"      → glyph and underline together
	// "none"      → no in-editor decorations (markers remain in the file)
	indicatorStyle: "icon" | "underline" | "both" | "none";
	defaultVisibility: "show" | "hide" | "last";

	// Visual character of the anchor underline. Applies to every category;
	// per-category urgency comes from the tier on each CategoryDefinition.
	anchorStyle: "solid" | "wavy" | "dotted" | "dashed";

	// Baseline thickness used by the "normal" tier. "subtle" tier always
	// renders thin, "strong" tier always renders thick, regardless of this
	// setting.
	anchorThickness: "thin" | "medium" | "thick";

	// How visible resolved comments stay in the editor. "normal" dims to
	// opacity 0.5, which can read as unreadable in dark themes where the
	// base text is already darker. "bright" keeps resolved content legible
	// (opacity 0.85) while still distinguishing it from open comments via
	// the strikethrough on the icon and the muted underline color.
	resolvedBrightness: "normal" | "bright";

	resolvedDisplay: "dim" | "hide";

	enableAuthorTag: boolean;
	authorTag: string;

	composerLocation: "modal" | "panel";

	debugMode: boolean;
	debugLogTarget: "console" | "vault";

	settingsBackupPath: string | undefined;

	// Position drift snapshots keyed by comment id (F-234). Captured on demand
	// by the detection command; not user-editable.
	driftSnapshots?: Record<string, { before: string; after: string }>;

	// Comments the user has starred for quick access. Stored as comment IDs.
	// Comments without an id cannot be starred.
	starredComments: string[];

	// Last-active tab in the Annoteca hub panel. Restored on manual panel open.
	// Marker clicks force the "thread" tab regardless.
	lastHubTab: "thread" | "outline" | "starred";

	// Scope state for the Thread tab. Persists across restarts so users keep
	// their working context. Re-evaluated against the active file on load.
	scopeState: ScopeState;

	// Status filter for the Thread tab. Defaults to "open" so the panel
	// surfaces what needs attention.
	statusFilter: StatusFilter;

	// When true (default), files other than the active comment's host file
	// are collapsed in multi-file Thread scopes. Helps keep long lists
	// scannable when the user is focused on one chapter.
	autoCollapseInactiveFiles: boolean;

	// User-saved category presets. Built-in presets live in categories.ts and
	// are not stored here.
	customPresets: UserPreset[];

	// Indicator size in the editor (inline icon + gutter dot).
	indicatorSize: "small" | "medium" | "large";
}

// Discriminated union for scope shapes. The shape determines what set of
// files the panel includes; anchorPath disambiguates folder/file scopes.
export type ScopeShape =
	| { kind: "file" }
	| { kind: "folder"; subfolders: boolean }
	| { kind: "vault" }
	| { kind: "property"; key: string; value: string }
	| { kind: "tag"; tag: string };

export interface ScopeState {
	shape: ScopeShape;
	anchorPath: string; // file path (for file scope) or folder path (for folder scope); ignored for vault
	pinned: boolean; // when true, scope does not auto-collapse when the active file moves out
}

export type StatusFilter = "open" | "resolved" | "all";
