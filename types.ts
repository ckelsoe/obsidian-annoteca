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

export interface Comment {
	id: string | undefined;          // 8-char base36 when present
	category: string;                 // matches /^[a-z](-?[a-z0-9])*$/
	body: string;                     // freeform inline markdown
	date: string | undefined;         // ISO YYYY-MM-DD
	author: string | undefined;       // short author tag
	replies: Reply[];                 // chronological, oldest first
	resolution: Resolution | undefined;
	marker: MarkerRange;
}

// Used by views.ts when listing vault-wide comments alongside their host file.
export interface LocatedComment {
	path: string;
	comment: Comment;
}

export interface CategoryDefinition {
	id: string;             // dash-separated lowercase, matches parser rule
	displayName: string;    // sentence case for UI
	icon?: string;          // Obsidian icon name; falls back to category default
	color?: string;         // CSS variable name or hex; falls back to theme variable
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

	indicatorStyle: "gutter" | "inline" | "both" | "none";
	defaultVisibility: "show" | "hide" | "last";

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
