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

export interface AnnotecaSettings {
	categories: CategoryDefinition[];
	defaultCategory: string;
	enableScholarlyPreset: boolean;

	indicatorStyle: "gutter" | "inline" | "both" | "none";
	defaultVisibility: "show" | "hide" | "last";

	resolvedDisplay: "dim" | "hide";

	enableAuthorTag: boolean;
	authorTag: string;

	debugMode: boolean;
	debugLogTarget: "console" | "vault";

	settingsBackupPath: string | undefined;
}
