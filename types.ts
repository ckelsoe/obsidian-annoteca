// Shared types for the Annoteca plugin. No Obsidian dependency.

export interface Reply {
	author: string;
	date: string; // ISO date (YYYY-MM-DD) or full timestamp (YYYY-MM-DDTHH:MM:SS)
	body: string;
}

export interface Resolution {
	author: string;
	date: string; // ISO date (YYYY-MM-DD) or full timestamp (YYYY-MM-DDTHH:MM:SS)
	note: string; // may be empty
}

// Addressed state (F-270): an edit has been applied in response to the comment
// and is awaiting the reviewer's accept / revise / reject. A highlighted
// sub-state of "open", not a terminal state. When the applied edit replaced the
// anchored prose, `original` holds the verbatim pre-edit text from the
// `annoteca-original` fence (F-271) so reject can revert it.
export interface Addressed {
	author: string;
	date: string; // ISO date (YYYY-MM-DD) or full timestamp (YYYY-MM-DDTHH:MM:SS)
	note: string; // may be empty
	original?: string; // verbatim replaced text from the annoteca-original fence
}

export interface MarkerRange {
	start: number; // byte offset of leading `<` of `<!--`
	end: number; // byte offset one past the trailing `>` of `-->`
}

export interface AnchorText {
	text: string; // the captured commented text; up to 80 chars
	truncated: boolean; // true when the original selection was longer than 80 chars
}

export interface Comment {
	id: string | undefined; // 8-char base36 when present
	category: string; // matches /^[a-z](-?[a-z0-9])*$/
	body: string; // freeform inline markdown
	date: string | undefined; // ISO date or full timestamp (YYYY-MM-DDTHH:MM:SS)
	author: string | undefined; // short author tag
	anchor: AnchorText | undefined; // commented text captured at creation; undefined for cursor-position comments
	replies: Reply[]; // chronological, oldest first
	addressed: Addressed | undefined; // F-270: pending accept/revise/reject; absent when not addressed
	resolution: Resolution | undefined;
	marker: MarkerRange;
}

// Used by views.ts when listing vault-wide comments alongside their host file.
export interface LocatedComment {
	path: string;
	comment: Comment;
}

export type AnchorTier = 'subtle' | 'normal' | 'strong';

export interface CategoryDefinition {
	id: string; // dash-separated lowercase, matches parser rule
	displayName: string; // sentence case for UI
	icon?: string; // Obsidian icon name; falls back to category default
	color?: string; // CSS variable name or hex; falls back to theme variable
	tier?: AnchorTier; // anchor-underline urgency; undefined === "normal"
}

// Per-author / per-collaborator styling (F-274/F-275). `tag` is the author
// token written to [author=...] / [reply <tag> ...] lines; `color` tints that
// author's name and replies so a multi-party thread is scannable. The tag list
// also populates the reply composer's author picker.
export interface AuthorStyle {
	tag: string;
	color?: string; // CSS color (hex or variable); falls back to the theme default
}

// User-saved preset. Stored in settings alongside the built-in presets in
// categories.ts. Built-ins are read-only; user-saved ones can be loaded,
// renamed, deleted.
export interface UserPreset {
	id: string; // generated unique id
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
	indicatorStyle: 'icon' | 'underline' | 'both' | 'none';
	defaultVisibility: 'show' | 'hide' | 'last';

	// Marker hover preview: show the comment/thread preview popup when hovering a
	// marker or its anchor underline in the editor. On by default. The toggle is
	// live; hoverDelay (the dwell before the popup appears) is read when the
	// editor extension is built, so a change to it takes effect on next reload.
	hoverPreview: boolean;
	hoverDelay: 'instant' | 'short' | 'default' | 'relaxed';

	// Visual character of the anchor underline. Applies to every category;
	// per-category urgency comes from the tier on each CategoryDefinition.
	anchorStyle: 'solid' | 'wavy' | 'dotted' | 'dashed';

	// Baseline thickness used by the "normal" tier. "subtle" tier always
	// renders thin, "strong" tier always renders thick, regardless of this
	// setting.
	anchorThickness: 'thin' | 'medium' | 'thick';

	// How visible resolved comments stay in the editor. "normal" dims to
	// opacity 0.5, which can read as unreadable in dark themes where the
	// base text is already darker. "bright" keeps resolved content legible
	// (opacity 0.85) while still distinguishing it from open comments via
	// the strikethrough on the icon and the muted underline color.
	resolvedBrightness: 'normal' | 'bright';

	resolvedDisplay: 'dim' | 'hide';

	// When true, resolving a comment removes its marker from the file instead
	// of appending a [resolved ...] line. Default false: keep-in-place history
	// is the format's default; this is the opt-in for clean files.
	deleteOnResolve: boolean;

	enableAuthorTag: boolean;
	authorTag: string;

	// Per-author/per-collaborator tags and colors (F-274/F-275). Drives the
	// reply composer's author picker and the per-author tinting of names and
	// replies. Empty by default; the single authorTag above still works for the
	// one-human-plus-AI case.
	authorStyles: AuthorStyle[];

	composerLocation: 'modal' | 'panel';

	// When true, selecting text in the editor shows a small floating "Comment"
	// button next to the selection that opens the composer for that range. Off
	// by default: a popup on every selection is intrusive for readers who select
	// text for other reasons. Opt-in for reviewers who annotate by mouse.
	selectionPopup: boolean;

	// When true (default), Enter submits a comment/reply and Shift+Enter inserts
	// a newline. When false, Cmd/Ctrl+Enter submits and Enter inserts a newline.
	// Applies to both the new-comment composer and the reply composer.
	submitCommentOnEnter: boolean;

	// How the editor scrolls when navigating to a comment.
	//   "top"     — anchor the marker near the top of the editor pane, always
	//               (default). Gives a predictable reading position on small
	//               screens.
	//   "center"  — center the marker in the editor, always.
	//   "minimal" — scroll the minimum needed, and not at all when the marker is
	//               already visible (the F-276 don't-yank behavior).
	// Migrated from the legacy centerCommentOnNavigate boolean (true -> "center",
	// false/absent -> "top").
	markerScrollAlign: 'top' | 'center' | 'minimal';

	debugMode: boolean;
	debugLogTarget: 'console' | 'vault';

	settingsBackupPath: string | undefined;

	// Position drift snapshots keyed by comment id (F-234). Captured on demand
	// by the detection command; not user-editable.
	driftSnapshots?: Record<string, { before: string; after: string }>;

	// Comments the user has starred for quick access. Stored as comment IDs.
	// Comments without an id cannot be starred.
	starredComments: string[];

	// Last-active tab in the Annoteca hub panel. Restored on manual panel open.
	// Marker clicks force the "thread" tab regardless.
	lastHubTab: 'thread' | 'outline' | 'starred';

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
	indicatorSize: 'small' | 'medium' | 'large';

	// Where "Export AI skill" writes its SKILL.md inside the vault:
	// .claude/skills/ (Claude Code), .agent/skills/ (other assistants), or both.
	skillExportTarget: 'claude' | 'agent' | 'both';

	// Skill staleness tracking. exportedSkillVersion is the schema version
	// stamped at the last export; skillStaleNoticeShownFor is the schema version
	// the on-load "re-export" notice last fired for, so it warns once per bump.
	exportedSkillVersion?: number;
	skillStaleNoticeShownFor?: number;

	// Reading-view comment indicator. Markers are HTML comments, which the
	// renderer drops; this surfaces their presence in reading view.
	// "banner"      → one note-level pill with file totals
	// "per-section" → a badge on each rendered section containing markers
	// "both"        → banner and badges
	// "off"         → nothing rendered
	readingViewIndicator: 'off' | 'banner' | 'per-section' | 'both';
}

// Discriminated union for scope shapes. The shape determines what set of
// files the panel includes; anchorPath disambiguates folder/file scopes.
export type ScopeShape =
	| { kind: 'file' }
	| { kind: 'folder'; subfolders: boolean }
	| { kind: 'vault' }
	| { kind: 'property'; key: string; value: string }
	| { kind: 'tag'; tag: string };

export interface ScopeState {
	shape: ScopeShape;
	anchorPath: string; // file path (for file scope) or folder path (for folder scope); ignored for vault
	pinned: boolean; // when true, scope does not auto-collapse when the active file moves out
}

export type StatusFilter = 'open' | 'resolved' | 'all';
