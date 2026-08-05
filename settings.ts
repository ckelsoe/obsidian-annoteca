import {
	App,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	Notice,
	ButtonComponent,
	setIcon,
} from 'obsidian';

import type AnnotecaPlugin from './main';
import type {
	AnnotecaSettings,
	AuthorStyle,
	CategoryDefinition,
	ScopeShape,
	ScopeState,
	UserPreset,
} from './types';
import {
	DEFAULT_CATEGORIES,
	DEFAULT_PRESETS,
	isValidCategoryName,
	resolveEnabledCategories,
	reorderCategories,
	moveCategory,
} from './categories';
import {
	isAuthorToken,
	isSerializableCategory,
	sanitizeAuthorToken,
} from './parser';
import {
	createStackedRow,
	createColorPicker,
	createIconPicker,
} from './ui-helpers';
import { supportsDragAndDrop } from './platform';

// Community discussion for this plugin. This must stay a never-expiring
// discord.gg invite. A discord.com/channels/... deep link only resolves for
// accounts already in the server, so it cannot get anyone in, and a default
// invite expires after 7 days and would rot in a shipped release.
const DISCORD_URL = 'https://discord.gg/gd6tKJDPj4';

export const DEFAULT_SETTINGS: AnnotecaSettings = {
	categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
	defaultCategory: 'clarify',
	enableScholarlyPreset: false,
	enableIndexEntryPreset: false,

	indicatorStyle: 'both',
	defaultVisibility: 'show',

	hoverPreview: true,
	hoverDelay: 'default',
	// Placeholder only. The real first-run value is decided per platform in
	// loadSettings via resolveMarkerClickAction, because reading Platform at
	// module load is unreliable. 'panel' is the historical behaviour, so it is
	// the safe literal to sit here.
	markerClickAction: 'panel',
	markerReplyCount: true,
	renderMarkdownBodies: true,

	anchorStyle: 'wavy',
	anchorThickness: 'medium',
	resolvedBrightness: 'normal',

	resolvedDisplay: 'dim',
	deleteOnResolve: false,

	composerLocation: 'panel',
	selectionPopup: false,
	submitCommentOnEnter: true,
	markerScrollAlign: 'top',

	enableAuthorTag: false,
	authorTag: '',
	authorStyles: [],

	debugMode: false,
	debugLogTarget: 'console',

	settingsBackupPath: undefined,

	starredComments: [],
	lastHubTab: 'thread',
	hubTabAutoCreated: false,
	scopeState: {
		shape: { kind: 'file' },
		anchorPath: '',
		pinned: false,
	},
	statusFilter: 'open',
	autoCollapseInactiveFiles: true,
	customPresets: [],
	indicatorSize: 'medium',
	skillExportTarget: 'claude',
	readingViewIndicator: 'banner',
};

// data.json is user-editable, and it also arrives over sync and out of a
// restored backup, so nothing in it is guaranteed to be the type it was written
// as. Reads all over this plugin are truthiness tests, `for...of` loops and
// `.filter` calls, so a stored string "false" silently turns a disabled setting
// back on, and a stored `{}` where an array belongs throws on the first
// iteration and takes the whole load down with it.
//
// One choke point rather than a check per read. The per-field validations that
// used to sit in loadSettings and mergeRestoredSettings only ever covered the
// fields somebody had already been burned by, so every setting added since
// arrived unchecked. Everything now goes through normalizeSettings, and the
// table below is a mapped type over every key of the settings interface, so a
// new setting with no validator fails the BUILD instead of shipping
// unvalidated.

type SettingKey = keyof Required<AnnotecaSettings>;

// A validator answers exactly one question: is this stored value usable as it
// stands? It returns the value when yes and `undefined` when no.
//
// `undefined` always means "fall back", never "store undefined". Absent and
// rejected are deliberately indistinguishable to the caller, because the answer
// to both is the same: whatever the fallback chain settles on, which is the
// live value on the restore path and the shipped default on load.
type SettingValidator<K extends SettingKey> = (
	raw: unknown,
) => Required<AnnotecaSettings>[K] | undefined;

// Exported because loadSettings needs the SAME narrowing for the migrations it
// runs against the raw stored blob. A second copy there is a second thing to
// keep in step, and the one that matters is not the check itself but the
// question it settles: is this thing safe to reach into at all.
export function isRecord(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function bool(raw: unknown): boolean | undefined {
	return typeof raw === 'boolean' ? raw : undefined;
}

function str(raw: unknown): string | undefined {
	return typeof raw === 'string' ? raw : undefined;
}

function num(raw: unknown): number | undefined {
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

// Literal-set gate for the enum-valued settings. The allowed values are passed
// as a rest parameter so TypeScript infers the literal union and the table
// below fails to compile if a listed value is not in that setting's type.
function oneOf<T extends string>(
	...allowed: readonly T[]
): (raw: unknown) => T | undefined {
	return (raw) =>
		typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
			? (raw as T)
			: undefined;
}

// Elementwise filter for the structural arrays. A single bad element drops
// itself rather than the whole list: a synced data.json with one malformed
// category should not cost the user the other six.
function arrayOf<T>(
	validate: (raw: unknown) => T | undefined,
): (raw: unknown) => T[] | undefined {
	return (raw) => {
		if (!Array.isArray(raw)) return undefined;
		const kept: T[] = [];
		for (const item of raw) {
			const value = validate(item);
			if (value !== undefined) kept.push(value);
		}
		return kept;
	};
}

function titleCaseId(id: string): string {
	return id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
}

function validCategory(raw: unknown): CategoryDefinition | undefined {
	if (!isRecord(raw)) return undefined;
	// The id is the one field that cannot be repaired: it is written into every
	// marker and has to satisfy the parser's category grammar.
	//
	// The PARSER's grammar, not isValidCategoryName. That one is the house style
	// for a name being created in the settings UI and is stricter on purpose,
	// but a stored `my--topic` or `trailing-` round-trips through the marker
	// perfectly well. Validating what is already on disk against the creation
	// rule would delete a working category along with its icon, color and
	// display name, and leave every comment filed under it unable to be
	// re-selected. Reject what the format cannot hold; leave house style to the
	// path where a name is being made up.
	if (typeof raw.id !== 'string' || !isSerializableCategory(raw.id))
		return undefined;
	const cat: CategoryDefinition = {
		id: raw.id,
		// Derived rather than rejected. A category with an unusable display name
		// is still a category comments in the vault are filed under, and dropping
		// it would strand them; this is the derivation getCategoryOrFallback
		// already applies when a category is missing entirely.
		displayName:
			typeof raw.displayName === 'string' && raw.displayName !== ''
				? raw.displayName
				: titleCaseId(raw.id),
	};
	if (typeof raw.icon === 'string') cat.icon = raw.icon;
	if (typeof raw.color === 'string') cat.color = raw.color;
	const tier = oneOf('subtle', 'normal', 'strong')(raw.tier);
	if (tier !== undefined) cat.tier = tier;
	return cat;
}

function validAuthorStyle(raw: unknown): AuthorStyle | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.tag !== 'string' || raw.tag === '') return undefined;
	const style: AuthorStyle = { tag: raw.tag };
	if (typeof raw.color === 'string') style.color = raw.color;
	return style;
}

function validPreset(raw: unknown): UserPreset | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.id !== 'string' || raw.id === '') return undefined;
	const categories = arrayOf(validCategory)(raw.categories);
	// A preset with nothing left to cherry-pick is a dead row in the browser.
	if (categories === undefined || categories.length === 0) return undefined;
	return {
		id: raw.id,
		displayName:
			typeof raw.displayName === 'string' && raw.displayName !== ''
				? raw.displayName
				: raw.id,
		categories,
	};
}

function validScopeShape(raw: unknown): ScopeShape | undefined {
	if (!isRecord(raw)) return undefined;
	switch (raw.kind) {
		case 'file':
			return { kind: 'file' };
		case 'vault':
			return { kind: 'vault' };
		case 'folder':
			return { kind: 'folder', subfolders: raw.subfolders === true };
		case 'property':
			return typeof raw.key === 'string' && typeof raw.value === 'string'
				? { kind: 'property', key: raw.key, value: raw.value }
				: undefined;
		case 'tag':
			return typeof raw.tag === 'string'
				? { kind: 'tag', tag: raw.tag }
				: undefined;
		default:
			return undefined;
	}
}

function validScopeState(raw: unknown): ScopeState | undefined {
	if (!isRecord(raw)) return undefined;
	const shape = validScopeShape(raw.shape);
	// The shape drives a discriminated switch in scope.ts. An unknown kind there
	// resolves to no files at all, which reads as "the panel is broken".
	if (shape === undefined) return undefined;
	return {
		shape,
		anchorPath: typeof raw.anchorPath === 'string' ? raw.anchorPath : '',
		pinned: raw.pinned === true,
	};
}

function validDriftSnapshots(
	raw: unknown,
): Record<string, { before: string; after: string }> | undefined {
	if (!isRecord(raw)) return undefined;
	// Null prototype because the KEYS here are untrusted too, not just the
	// values. On a plain object literal, `out['__proto__'] = snap` runs the
	// inherited setter rather than creating a key, so a hand-edited file with a
	// `__proto__` entry would lose that snapshot AND leave `out` with a
	// prototype nobody asked for.
	const out = Object.create(null) as Record<
		string,
		{ before: string; after: string }
	>;
	for (const [id, snap] of Object.entries(raw)) {
		if (!isRecord(snap)) continue;
		if (typeof snap.before !== 'string' || typeof snap.after !== 'string')
			continue;
		out[id] = { before: snap.before, after: snap.after };
	}
	return out;
}

const validAuthorTag: SettingValidator<'authorTag'> = (raw) => {
	if (typeof raw !== 'string') return undefined;
	// Empty is a legitimate stored value: it is what "no tag set" looks like,
	// and sanitizing it would invent the token "user" for someone who never
	// asked for one. isAuthorToken deliberately answers only the grammar
	// question, so the "no tag set" case is spelled out here.
	if (raw === '' || isAuthorToken(raw)) return raw;
	// A display name with a space is the common shape here and is not a reason
	// to throw the tag away. sanitizeAuthorToken is the same repair serialize()
	// applies at the write funnel, imported rather than restated so the token
	// grammar has one implementation.
	return sanitizeAuthorToken(raw);
};

const validCategories: SettingValidator<'categories'> = (raw) => {
	const list = arrayOf(validCategory)(raw);
	// An empty list is not a usable state: the composer dropdown, the sidebar
	// grouping and every category lookup read this. Falling back restores the
	// shipped set, which is what loadSettings has always done for an absent or
	// empty list.
	return list === undefined || list.length === 0 ? undefined : list;
};

// One entry per key of the settings interface, over `Required<...>` so the
// optional keys need one too. Adding a setting without adding its validator is
// a type error.
const SETTING_VALIDATORS: {
	readonly [K in SettingKey]: SettingValidator<K>;
} = {
	categories: validCategories,
	defaultCategory: str,
	enableScholarlyPreset: bool,
	enableIndexEntryPreset: bool,
	indicatorStyle: oneOf('icon', 'underline', 'both', 'none'),
	defaultVisibility: oneOf('show', 'hide', 'last'),
	hoverPreview: bool,
	hoverDelay: oneOf('instant', 'short', 'default', 'relaxed'),
	markerClickAction: oneOf('panel', 'popover'),
	markerReplyCount: bool,
	renderMarkdownBodies: bool,
	anchorStyle: oneOf('solid', 'wavy', 'dotted', 'dashed'),
	anchorThickness: oneOf('thin', 'medium', 'thick'),
	resolvedBrightness: oneOf('normal', 'bright'),
	resolvedDisplay: oneOf('dim', 'hide'),
	deleteOnResolve: bool,
	enableAuthorTag: bool,
	authorTag: validAuthorTag,
	authorStyles: arrayOf(validAuthorStyle),
	composerLocation: oneOf('modal', 'panel'),
	selectionPopup: bool,
	submitCommentOnEnter: bool,
	markerScrollAlign: oneOf('top', 'center', 'minimal'),
	debugMode: bool,
	debugLogTarget: oneOf('console', 'vault'),
	settingsBackupPath: str,
	driftSnapshots: validDriftSnapshots,
	starredComments: arrayOf(str),
	lastHubTab: oneOf('thread', 'outline', 'starred'),
	hubTabAutoCreated: bool,
	scopeState: validScopeState,
	statusFilter: oneOf('open', 'resolved', 'all'),
	autoCollapseInactiveFiles: bool,
	customPresets: arrayOf(validPreset),
	indicatorSize: oneOf('small', 'medium', 'large'),
	skillExportTarget: oneOf('claude', 'agent', 'both'),
	exportedSkillVersion: num,
	skillStaleNoticeShownFor: num,
	readingViewIndicator: oneOf('off', 'banner', 'per-section', 'both'),
};

// The single ingress for anything read out of data.json or a backup file.
//
// Precedence per key: the stored value if it validates, else the caller's
// fallback if THAT validates, else the shipped default. All three legs run
// through the validator, including the default. That is not paranoia about
// DEFAULT_SETTINGS being wrong; it is what guarantees the value handed back was
// BUILT by a validator, and every structural validator builds fresh objects.
//
// So nothing here returns a reference into `raw`, `fallback` or
// DEFAULT_SETTINGS, which matters because the settings UI edits categories and
// author styles in place. Taking the default leg raw is the version of this
// that shipped broken for one call shape: `normalizeSettings(raw, {})` skipped
// the fallback leg for every key and aliased the module-level default arrays
// straight into live settings.
export function normalizeSettings(
	raw: unknown,
	fallback: unknown = DEFAULT_SETTINGS,
): AnnotecaSettings {
	const stored = isRecord(raw) ? raw : {};
	const prior = isRecord(fallback) ? fallback : {};
	const out: Record<string, unknown> = {};

	for (const key of Object.keys(SETTING_VALIDATORS) as SettingKey[]) {
		const validate = SETTING_VALIDATORS[key] as (r: unknown) => unknown;
		// `??` and not `||`: `false` is a valid value for twelve of these keys
		// and must not fall through to the default.
		const value =
			(key in stored ? validate(stored[key]) : undefined) ??
			(key in prior ? validate(prior[key]) : undefined) ??
			validate(DEFAULT_SETTINGS[key]);
		// An optional key with no default stays absent rather than becoming an
		// explicit `undefined`, so `in` checks elsewhere keep working.
		if (value !== undefined) out[key] = value;
	}

	const settings = out as unknown as AnnotecaSettings;
	reconcileDefaultCategory(settings);
	return settings;
}

// The default category has to be one of the categories actually on offer.
// Turning a preset off, or removing the category a preset supplied, otherwise
// strands `defaultCategory` on an id that is no longer in the dropdown, and the
// composer opens with nothing selected.
//
// Mutates in place and reports whether it changed anything, because the two
// callers want different things from it: normalizeSettings just wants the
// invariant, the settings tab wants to know whether to tell the user.
export function reconcileDefaultCategory(s: AnnotecaSettings): boolean {
	const enabled = resolveSettingsCategories(s);
	const first = enabled[0];
	if (!first) return false;
	if (enabled.some((c) => c.id === s.defaultCategory)) return false;
	s.defaultCategory = first.id;
	return true;
}

// The whole "restore settings from a backup file" merge, in one pure function.
//
// It lives here rather than inline in the plugin method for a reason found by
// mutation: with the merge inline, deleting the normalizing entirely left the
// suite green, because no test reaches main.ts at runtime. A normalizer nothing
// can test is a normalizer that quietly stops running.
//
// Precedence is unchanged. Defaults fill gaps, the live settings win over
// those, and the backup wins over both, because restoring is an explicit
// request to take the file's values. Normalizing `current` first is what makes
// the fallback meaningful: a key the backup gets WRONG falls back to the live
// value rather than to the shipped default, so one bad line in a backup cannot
// quietly reset a setting the user never touched.
export function mergeRestoredSettings(
	current: AnnotecaSettings,
	parsed: Partial<AnnotecaSettings>,
): AnnotecaSettings {
	const live = normalizeSettings(current);
	return normalizeSettings({ ...live, ...parsed }, live);
}

// Resolve the active category list given current settings. Centralized so the
// modal, decorations, and views consume one source of truth.
export function resolveSettingsCategories(
	s: AnnotecaSettings,
): CategoryDefinition[] {
	const base = resolveEnabledCategories(
		s.categories,
		s.enableScholarlyPreset,
	);
	if (s.enableIndexEntryPreset && !base.find((c) => c.id === 'index-entry')) {
		base.push({
			id: 'index-entry',
			displayName: 'Index entry',
			icon: 'list',
			color: 'var(--text-accent)',
		});
	}
	return base;
}

export class AnnotecaSettingTab extends PluginSettingTab {
	private readonly plugin: AnnotecaPlugin;
	// Which category rows are expanded. Lives on the tab instance only so
	// re-renders (after saves) preserve expansion, but opening Settings fresh
	// starts collapsed. Not persisted to data.json.
	private readonly expandedCategoryIds = new Set<string>();

	// Id of the category row currently being dragged for reordering, or null
	// when no drag is in progress. Tracked on the instance (not dataTransfer
	// alone) so dragover can decide whether the pointer is over a valid target
	// without reading transfer data, which browsers withhold during dragover.
	private draggedCategoryId: string | null = null;

	constructor(app: App, plugin: AnnotecaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// Default-category options track the live category list; getSettingDefinitions
		// re-runs on every update() so this stays current after add/remove.
		const categoryOptions: Record<string, string> = {};
		for (const c of resolveSettingsCategories(this.plugin.settings)) {
			categoryOptions[c.id] = c.displayName;
		}

		return [
			{
				type: 'group',
				heading: 'Categories',
				items: [
					this.customBlock((host) => this.renderPresetSection(host)),
					{
						name: 'Index-entry preset',
						desc: 'Add an index-entry category for tagging concepts that should appear in a printed index. Pairs with the pandoc filter shipped under docs in the plugin repository.',
						control: {
							type: 'toggle',
							key: 'enableIndexEntryPreset',
						},
					},
					{
						name: 'Default category',
						desc: 'Selected in the add-comment modal by default.',
						control: {
							type: 'dropdown',
							key: 'defaultCategory',
							options: categoryOptions,
						},
					},
					this.customBlock((host) => this.renderCategoryList(host)),
					this.customBlock((host) => this.renderAddCategory(host)),
				],
			},
			{
				type: 'group',
				heading: 'Editor indicators',
				items: [
					{
						name: 'Indicator style',
						desc: "How comments are surfaced in the editor. The underline marks the text the comment was made against. The icon marks the comment's location when no text was selected at create time.",
						control: {
							type: 'dropdown',
							key: 'indicatorStyle',
							options: {
								icon: 'Inline icon only',
								underline: 'Anchor underline only',
								both: 'Icon and underline',
								none: 'Hidden',
							},
						},
					},
					{
						name: 'Indicator size',
						desc: 'Visual size of the marker icon in the editor.',
						control: {
							type: 'dropdown',
							key: 'indicatorSize',
							options: {
								small: 'Small',
								medium: 'Medium',
								large: 'Large',
							},
						},
					},
					{
						name: 'Marker hover preview',
						desc: 'Show a preview of the comment and its thread when you hover a marker or its underline in the editor. Turn off to rely on clicking the marker to open the side panel.',
						control: { type: 'toggle', key: 'hoverPreview' },
					},
					{
						name: 'Hover preview delay',
						desc: 'How long to hover before the preview appears. Takes effect after reloading the plugin.',
						control: {
							type: 'dropdown',
							key: 'hoverDelay',
							options: {
								instant: 'Instant',
								short: 'Short',
								default: 'Default',
								relaxed: 'Relaxed',
							},
						},
					},
					{
						name: 'Clicking a marker',
						desc: 'What happens when you click or tap a marker in the editor. Open in side panel shows the full thread; Show popover keeps the document in view. Defaults to the popover on phones and tablets, where there is no hover preview.',
						control: {
							type: 'dropdown',
							key: 'markerClickAction',
							options: {
								panel: 'Open in side panel',
								popover: 'Show popover',
							},
						},
					},
					{
						name: 'Render Markdown in comments',
						desc: 'Show comment bodies, replies and notes as formatted Markdown in the marker popover and the Hub panel, instead of their raw source. Links, emphasis, code and lists render. The one-line body shown beside a marker in the editor stays plain text either way, so it cannot reflow the document.',
						control: {
							type: 'toggle',
							key: 'renderMarkdownBodies',
						},
					},
					{
						name: 'Reply count on markers',
						desc: 'Show how many replies a thread has next to its marker icon in the editor. Markers with no replies are unchanged.',
						control: { type: 'toggle', key: 'markerReplyCount' },
					},
					{
						name: 'Anchor underline style',
						desc: 'Visual character of the underline drawn over commented text. Applies to every category.',
						control: {
							type: 'dropdown',
							key: 'anchorStyle',
							options: {
								wavy: 'Wavy',
								solid: 'Solid',
								dotted: 'Dotted',
								dashed: 'Dashed',
							},
						},
					},
					{
						name: 'Anchor underline thickness',
						desc: 'Baseline thickness for categories on the normal tier. Subtle always renders thin, strong always renders thick, regardless of this setting.',
						control: {
							type: 'dropdown',
							key: 'anchorThickness',
							options: {
								thin: 'Thin',
								medium: 'Medium',
								thick: 'Thick',
							},
						},
					},
					{
						name: 'Default visibility on file open',
						desc: 'Whether comments are visible when a file opens.',
						control: {
							type: 'dropdown',
							key: 'defaultVisibility',
							options: {
								show: 'Show',
								hide: 'Hide',
								last: 'Last state',
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Resolved comments',
				items: [
					{
						name: 'Resolved comment display',
						desc: 'How resolved comments appear in the editor.',
						control: {
							type: 'dropdown',
							key: 'resolvedDisplay',
							options: { dim: 'Dim', hide: 'Hide' },
						},
					},
					{
						name: 'Delete on resolve',
						desc: 'Resolving a comment permanently removes it from the file instead of keeping it as a dimmed [resolved] marker. The thread and its replies are gone; rely on git or backups for history. The separate "Resolve and remove" action always asks first; with this on, plain Resolve removes without asking.',
						control: { type: 'toggle', key: 'deleteOnResolve' },
					},
					{
						name: 'Resolved brightness',
						desc: 'How aggressively resolved comments are dimmed. Normal works well in light themes; bright keeps resolved content legible against dark backgrounds where the base text is already muted.',
						control: {
							type: 'dropdown',
							key: 'resolvedBrightness',
							options: { normal: 'Normal', bright: 'Bright' },
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Composer',
				items: [
					{
						name: 'Composer location',
						desc: 'Where the add-comment form appears. The side panel keeps the document visible while you draft.',
						control: {
							type: 'dropdown',
							key: 'composerLocation',
							options: {
								modal: 'Modal dialog',
								panel: 'Right side panel',
							},
						},
					},
					{
						name: 'Send comment on Enter',
						desc: 'When on, Enter sends the comment and Shift+Enter starts a new line. When off, send with Cmd or Ctrl plus Enter, and Enter starts a new line. Applies to the comment box and the reply box.',
						control: {
							type: 'toggle',
							key: 'submitCommentOnEnter',
						},
					},
					{
						name: 'Selection comment button',
						desc: 'Show a floating Comment button next to text you select in the editor, so you can start a comment with one click instead of the right-click menu. The Add comment here and Add comment for selection commands can also be bound to a hotkey.',
						control: { type: 'toggle', key: 'selectionPopup' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Reading view',
				items: [
					{
						name: 'Reading view indicator',
						desc: 'Comments are invisible in reading view (markers are HTML comments). Show a note-level banner with totals, a badge on each section that has comments, or both. Click an indicator to open the comment panel. Counts are threads; replies are not counted.',
						control: {
							type: 'dropdown',
							key: 'readingViewIndicator',
							options: {
								off: 'Off',
								banner: 'Note banner',
								'per-section': 'Per-section badges',
								both: 'Banner and badges',
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Panel and navigation',
				items: [
					{
						name: 'Auto-collapse other files in scope',
						desc: 'When the thread panel shows comments from multiple files, collapse files other than the one you are editing. Click a file header to expand it manually.',
						control: {
							type: 'toggle',
							key: 'autoCollapseInactiveFiles',
						},
					},
					{
						name: 'Marker position when navigating',
						desc: "Where a comment's marker lands in the editor when you jump to it. Top anchors it near the top of the pane for a predictable reading spot. Center puts it in the middle. Minimal scrolls the least needed and stays put if the marker is already visible, so opening the panel does not move your place.",
						control: {
							type: 'dropdown',
							key: 'markerScrollAlign',
							options: {
								top: 'Top of pane',
								center: 'Center',
								minimal: "Minimal (don't move if visible)",
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Authors',
				items: [
					{
						name: 'Author tag',
						desc: 'When enabled, new comments include an [author=...] line. Useful when collaborating with an AI agent or multiple reviewers.',
						control: { type: 'toggle', key: 'enableAuthorTag' },
					},
					{
						name: 'Author identifier',
						desc: 'Short tag with no spaces; maximum 32 characters.',
						visible: () => this.plugin.settings.enableAuthorTag,
						control: {
							type: 'text',
							key: 'authorTag',
							placeholder: 'reviewer',
							validate: (value: unknown) => {
								const v =
									typeof value === 'string'
										? value.trim()
										: '';
								return v === '' || isAuthorToken(v)
									? undefined
									: 'Use a single tag with no spaces (max 32 characters).';
							},
						},
					},
					this.customBlock((host) => this.renderAuthorStyles(host)),
				],
			},
			{
				type: 'group',
				heading: 'AI integration',
				items: [
					{
						name: 'Skill export destination',
						desc: 'Vault folder the exported skill file is written to. Claude Code reads .claude/skills; some other assistants read a .agent folder.',
						control: {
							type: 'dropdown',
							key: 'skillExportTarget',
							options: {
								claude: '.claude/skills (Claude Code)',
								agent: '.agent/skills (other assistants)',
								both: 'Both folders',
							},
						},
					},
					this.customBlock((host) => this.renderSkillExport(host)),
				],
			},
			{
				type: 'group',
				heading: 'Diagnostics',
				items: [
					{
						name: 'Debug mode',
						desc: 'Log additional information for troubleshooting. Off by default to avoid log spam.',
						control: { type: 'toggle', key: 'debugMode' },
					},
					{
						name: 'Debug log destination',
						desc: 'Where diagnostic output is written.',
						visible: () => this.plugin.settings.debugMode,
						control: {
							type: 'dropdown',
							key: 'debugLogTarget',
							options: {
								console: 'Browser console',
								vault: 'Log file in the vault',
							},
						},
					},
					this.customBlock((host) => this.renderFooter(host)),
				],
			},
		];
	}

	// Re-render after a data change. Obsidian owns the declarative tree, so
	// update() reconciles it from fresh definitions. Kept as a named method
	// because a dozen call sites mean it, not update(), is the thing this tab
	// does after a mutation.
	private rerender(): void {
		this.update();
	}

	// Version + links footer, the same trailing row the workspace's reference
	// plugin renders (shell-path-copy settings-tab renderFooter).
	private renderFooter(host: HTMLElement): void {
		host.addClass('annoteca-settings-footer');
		// One inner flex container, and the separators are a gap rather than
		// whitespace in text nodes. The row is a flex row, and a flex item drops
		// the whitespace at its own edges, so the old ' | ' spans could render as
		// "GitHub|Report issues". Same fix as the reference plugin's footer.
		const inner = host.createDiv({ cls: 'annoteca-settings-footer-inner' });
		inner.createSpan({ text: `Version ${this.plugin.manifest.version}` });
		// Each separator is grouped with the link that follows it into a single
		// nowrap flex item. The inner row wraps, and a bare separator span would
		// be its own wrap opportunity, so a narrow settings pane could produce a
		// line ending or starting with a stray "|".
		const link = (text: string, url: string) => {
			const item = inner.createSpan({
				cls: 'annoteca-settings-footer-link',
			});
			item.createSpan({
				cls: 'annoteca-settings-footer-separator',
				text: '|',
			});
			item.createEl('a', {
				text,
				href: url,
				attr: { target: '_blank', rel: 'noopener' },
			});
		};
		link('GitHub', 'https://github.com/ckelsoe/obsidian-annoteca');
		link('Discord', DISCORD_URL);
		link(
			'Report issues',
			'https://github.com/ckelsoe/obsidian-annoteca/issues',
		);
	}

	// Routes declarative controls to the plugin's own settings store and runs
	// each control's side effects in one place. authorTag is trimmed but keeps
	// its casing (the parser accepts mixed-case authors). Toggles that show or
	// hide dependent rows, or that change the default-category options, trigger
	// a full re-render via update().
	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[
			key
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'authorTag') {
			// Preserve the tag's casing; the parser accepts mixed-case authors.
			this.plugin.settings.authorTag =
				typeof value === 'string' ? value.trim() : '';
		} else {
			(this.plugin.settings as unknown as Record<string, unknown>)[key] =
				value;
		}

		// Turning a preset off removes categories from the offered set, and the
		// default may have been one of them. The remove-category button refuses
		// the delete in that situation, but refusing a toggle would be a strange
		// thing to do to someone switching a preset off, so this repoints the
		// default instead and says so. Running it for every key rather than for
		// the index-entry toggle alone means a future preset switch cannot
		// reintroduce the strand.
		//
		// Before the save, not after: the repointed value has to be part of what
		// gets written, or the strand comes straight back on the next load.
		const defaultMoved = reconcileDefaultCategory(this.plugin.settings);

		await this.plugin.saveSettings();

		// One re-render at the end rather than one per reason. Two of these can
		// fire for the same change (switching the index-entry preset off both
		// hides a row and moves the default), and the Hub already paid for a
		// double repaint once.
		let repaint = defaultMoved;
		switch (key) {
			case 'indicatorSize':
				this.plugin.applyIndicatorSize();
				break;
			case 'anchorStyle':
			case 'anchorThickness':
			case 'resolvedBrightness':
				this.plugin.applyAnchorAppearance();
				break;
			case 'enableIndexEntryPreset':
			case 'enableAuthorTag':
			case 'debugMode':
				repaint = true;
				break;
		}

		if (defaultMoved) {
			// The display name, not the id. `defaultCategory` holds `source-needed`
			// where every other string this tab shows the user says "Source needed".
			const moved = resolveSettingsCategories(this.plugin.settings).find(
				(c) => c.id === this.plugin.settings.defaultCategory,
			);
			new Notice(
				`Default category is now "${moved?.displayName ?? this.plugin.settings.defaultCategory}".`,
			);
		}
		// The bound dropdown still shows the old id until the definitions are
		// rebuilt, and its option list has to lose the removed category too.
		if (repaint) this.rerender();
	}

	// Wraps a block of custom DOM (preset browser, category accordion, add-category
	// form) in a full-width settings row. These keep the workspace stacked-row /
	// picker UX that the default control layout cannot reproduce, so they render
	// imperatively and stay out of settings search.
	private customBlock(build: (host: HTMLElement) => void) {
		return {
			name: '',
			searchable: false,
			render: (setting: Setting) => {
				const host = setting.settingEl;
				host.empty();
				host.addClass('annoteca-custom-block');
				build(host);
			},
		};
	}

	private renderSkillExport(container: HTMLElement): void {
		const setting = new Setting(container)
			.setName('Export AI skill')
			.setDesc(
				"Write a skill file into the vault that teaches an AI assistant this vault's comment format and categories. Re-export after changing categories or updating the plugin.",
			);

		// Live staleness indicator (F-277): reads the on-disk skill and reports
		// whether it matches the current guidance.
		const status = setting.descEl.createDiv({
			cls: 'annoteca-skill-status',
		});
		const updateStatus = async (): Promise<void> => {
			const s = await this.plugin.readExportedSkillStatus();
			status.removeClasses(['is-stale', 'is-current', 'is-missing']);
			if (s === 'missing') {
				status.setText('Not yet exported.');
				status.addClass('is-missing');
			} else if (s === 'stale') {
				status.setText(
					'Out of date; re-export to update your assistant.',
				);
				status.addClass('is-stale');
			} else {
				status.setText('Up to date.');
				status.addClass('is-current');
			}
		};
		void updateStatus();

		setting.addButton((b) =>
			b
				.setButtonText('Export')
				.setCta()
				.onClick(() => {
					this.plugin.exportAiSkill();
					// Refresh the indicator after the async write settles.
					window.setTimeout(() => {
						void updateStatus();
					}, 400);
				}),
		);
	}

	private renderAddCategory(container: HTMLElement): void {
		new Setting(container)
			.setName('Add category')
			.setDesc(
				'Lowercase letters, digits, and single dashes. Cannot start or end with a dash. A few format keywords are unavailable as category names.',
			)
			.addText((t) =>
				t.setPlaceholder('Fact-check').then((text) => {
					let pendingName = '';
					text.onChange((v) => {
						pendingName = v.trim();
					});

					new ButtonComponent(text.inputEl.parentElement ?? container)
						.setButtonText('Add')
						.setCta()
						.onClick(async () => {
							if (!pendingName) return;
							if (!isValidCategoryName(pendingName)) {
								new Notice('Invalid category name.');
								return;
							}
							if (
								this.plugin.settings.categories.some(
									(c) => c.id === pendingName,
								)
							) {
								new Notice('Category already exists.');
								return;
							}
							this.plugin.settings.categories.push({
								id: pendingName,
								displayName:
									pendingName.charAt(0).toUpperCase() +
									pendingName.slice(1).replace(/-/g, ' '),
							});
							await this.plugin.saveSettings();
							this.rerender();
						});
				}),
			);
	}

	private renderPresetSection(container: HTMLElement): void {
		const customPresets = this.plugin.settings.customPresets;
		const allPresets: Array<{
			id: string;
			displayName: string;
			categories: readonly CategoryDefinition[];
			isCustom: boolean;
		}> = [
			...DEFAULT_PRESETS.map((p) => ({ ...p, isCustom: false })),
			...customPresets.map((p) => ({ ...p, isCustom: true })),
		];

		const { content } = createStackedRow(container, {
			name: 'Browse presets',
			description:
				'Cherry-pick categories from any preset into your working list. Picking a preset never replaces existing categories.',
		});

		// Preset selector dropdown.
		const selectorRow = content.createDiv({
			cls: 'annoteca-preset-selector',
		});
		const select = selectorRow.createEl('select', { cls: 'dropdown' });
		for (const p of allPresets) {
			select.createEl('option', {
				value: p.id,
				text: p.isCustom ? `★ ${p.displayName}` : p.displayName,
			});
		}

		// Preview of selected preset's categories with checkboxes.
		const previewArea = content.createDiv({
			cls: 'annoteca-preset-preview',
		});

		const renderPreview = (): void => {
			previewArea.empty();
			const selected = allPresets.find((p) => p.id === select.value);
			if (!selected) return;
			const existingIds = new Set(
				this.plugin.settings.categories.map((c) => c.id),
			);
			const checks: Array<{
				cat: CategoryDefinition;
				input: HTMLInputElement;
				conflict: boolean;
			}> = [];

			for (const cat of selected.categories) {
				const conflict = existingIds.has(cat.id);
				const row = previewArea.createDiv({
					cls: `annoteca-preset-cat${conflict ? ' is-conflict' : ''}`,
				});
				const input = row.createEl('input', {
					attr: { type: 'checkbox' },
				});
				input.disabled = conflict;
				const label = row.createSpan({
					cls: 'annoteca-preset-cat-label',
				});
				if (cat.icon) {
					const iconEl = label.createSpan({
						cls: 'annoteca-preset-cat-icon',
					});
					setIcon(iconEl, cat.icon);
				}
				label.createSpan({ text: cat.displayName });
				if (conflict) {
					row.createSpan({
						cls: 'annoteca-preset-conflict',
						text: 'already in list',
					});
				}
				checks.push({ cat, input, conflict });
			}

			const actions = previewArea.createDiv({
				cls: 'annoteca-preset-actions',
			});
			const addBtn = actions.createEl('button', {
				cls: 'annoteca-preset-add mod-cta',
				text: 'Add selected categories',
				attr: { type: 'button' },
			});
			addBtn.addEventListener('click', () => {
				const chosen = checks
					.filter((c) => !c.conflict && c.input.checked)
					.map((c) => c.cat);
				if (chosen.length === 0) {
					new Notice('Pick at least one category.');
					return;
				}
				this.plugin.settings.categories.push(
					...chosen.map((c) => ({ ...c })),
				);
				void this.plugin.saveSettings();
				new Notice(
					`Added ${chosen.length} categor${chosen.length === 1 ? 'y' : 'ies'}.`,
				);
				this.rerender();
			});

			if (selected.isCustom) {
				const deleteBtn = actions.createEl('button', {
					cls: 'annoteca-preset-delete',
					text: 'Delete preset',
					attr: { type: 'button' },
				});
				deleteBtn.addEventListener('click', () => {
					this.plugin.settings.customPresets =
						this.plugin.settings.customPresets.filter(
							(p) => p.id !== selected.id,
						);
					void this.plugin.saveSettings();
					this.rerender();
				});
			}
		};

		select.addEventListener('change', renderPreview);
		renderPreview();

		// Save current categories as a custom preset.
		const { content: saveContent } = createStackedRow(container, {
			name: 'Save current as preset',
			description:
				'Capture your current working categories under a name so you can reuse them later or share between vaults.',
		});
		const saveRow = saveContent.createDiv({ cls: 'annoteca-preset-save' });
		const nameInput = saveRow.createEl('input', {
			cls: 'annoteca-preset-save-name',
			attr: { type: 'text', placeholder: 'Preset name' },
		});
		const saveBtn = saveRow.createEl('button', {
			cls: 'annoteca-preset-save-button mod-cta',
			text: 'Save',
			attr: { type: 'button' },
		});
		saveBtn.addEventListener('click', () => {
			const name = nameInput.value.trim();
			if (name.length === 0) {
				new Notice('Give the preset a name.');
				return;
			}
			const id = `user-${Date.now().toString(36)}`;
			const preset: UserPreset = {
				id,
				displayName: name,
				categories: this.plugin.settings.categories.map((c) => ({
					...c,
				})),
			};
			this.plugin.settings.customPresets.push(preset);
			void this.plugin.saveSettings();
			new Notice(`Saved preset “${name}”.`);
			this.rerender();
		});
	}

	private renderCategoryList(container: HTMLElement): void {
		const list = container.createDiv({ cls: 'annoteca-category-list' });
		this.refreshCategoryList(list);
	}

	// Persist a mutation to `settings.categories` and bring the UI back in step.
	// Reorder, remove, and the move buttons all need exactly this, so it lives
	// here rather than being written out at each call site.
	//
	// rerender() is the whole repaint. It used to be preceded by a direct
	// refreshCategoryList(list) call, on the belief that update() left a custom
	// block's DOM alone. It does not: update() runs the block's render callback
	// again against a new host, synchronously, so the hand repaint landed on a
	// node that was detached and replaced microseconds later.
	private commitCategoryChange(): void {
		void this.plugin.saveSettings();
		this.rerender();
	}

	// Paint the category rows into a freshly created list element. Called from
	// renderCategoryList, which is the custom block's render callback, so this
	// runs once per render of the block and update() is what re-runs it.
	private refreshCategoryList(list: HTMLElement): void {
		list.empty();
		for (const cat of this.plugin.settings.categories) {
			this.renderCategoryRow(list, cat);
		}
	}

	// Accordion row: collapsed summary (icon + name + color dot + identifier
	// + chevron) plus a hidden detail panel with the full editor. Expansion
	// state lives in `expandedCategoryIds` so it survives re-renders.
	private renderCategoryRow(
		list: HTMLElement,
		cat: CategoryDefinition,
	): void {
		const isProtected = cat.id === 'uncategorized';
		const isExpanded = this.expandedCategoryIds.has(cat.id);

		const row = list.createDiv({
			cls: `annoteca-category-row${isExpanded ? ' is-expanded' : ''}`,
			// Lets the move handlers find this row again after the list is
			// repainted, so keyboard focus can be put back where the user left it.
			attr: { 'data-annoteca-category': cat.id },
		});

		// --- Summary row ------------------------------------------------
		// The reorder controls are siblings of the summary button, not children
		// of it. The summary is a <button>, and nesting interactive elements
		// inside a button is invalid HTML that assistive tech resolves
		// inconsistently. A flex header holds the two side by side instead.
		const header = row.createDiv({ cls: 'annoteca-category-header' });

		const reorder = header.createDiv({
			cls: 'annoteca-category-reorder',
		});

		// Drag handle for reordering, offered in addition to the move buttons
		// below. Rendered only where HTML5 DnD actually fires: on touch it never
		// does, so showing a grip there would be an affordance that silently
		// does nothing. The buttons are the path that always works.
		if (supportsDragAndDrop()) {
			const handle = reorder.createSpan({
				cls: 'annoteca-category-drag-handle',
				attr: { draggable: 'true', 'aria-label': 'Drag to reorder' },
			});
			setIcon(handle, 'grip-vertical');
			handle.addEventListener('dragstart', (e: DragEvent) => {
				this.draggedCategoryId = cat.id;
				row.addClass('is-dragging');
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'move';
					e.dataTransfer.setData('text/plain', cat.id);
				}
			});
			handle.addEventListener('dragend', () => {
				this.draggedCategoryId = null;
				row.removeClass('is-dragging');
				for (const r of list.findAll('.annoteca-category-row')) {
					r.removeClass('is-drag-over');
				}
			});
		}

		const index = this.plugin.settings.categories.findIndex(
			(c) => c.id === cat.id,
		);
		const isFirst = index <= 0;
		const isLast = index === this.plugin.settings.categories.length - 1;

		// Repainting the list destroys the button that was just clicked, which
		// drops focus to the document and forces a keyboard user to tab back in
		// for every single step of a move. Put focus on the equivalent button in
		// the row's new position instead. When the row has landed at an end, the
		// button just used is now disabled, so hand focus to the opposite one
		// rather than to something inert.
		//
		// Searched from containerEl, and only from containerEl. `list` is the
		// element this row was painted into, and by the time this runs
		// commitCategoryChange has called update(), which replaced the whole
		// custom block: `list` is detached and holds the pre-move order. The
		// search used to try `list` first and fall back to containerEl, which
		// read as belt and braces but could only ever take the fallback.
		// containerEl survives the re-render, so it is the one root that works.
		const refocusAfterMove = (direction: 'up' | 'down'): void => {
			const moved = this.containerEl
				.findAll('.annoteca-category-row')
				.find((r) => r.dataset.annotecaCategory === cat.id);
			if (!moved) return;
			const button = (d: 'up' | 'down') =>
				moved?.querySelector<HTMLButtonElement>(
					`.annoteca-category-move[data-annoteca-move="${d}"]`,
				);
			const same = button(direction);
			const target =
				same && !same.disabled
					? same
					: button(direction === 'up' ? 'down' : 'up');
			target?.focus();
		};

		// Names the category, because a screen reader announcing a bare "Move up"
		// in a list of them says nothing useful. Single source for the string so
		// the initial render and the rename sync below cannot drift apart.
		const moveLabel = (d: 'up' | 'down', displayName: string): string =>
			`${d === 'up' ? 'Move up' : 'Move down'}: ${displayName}`;

		// Renaming a category updates the summary text in place rather than
		// rebuilding the row, so every other place the display name is baked in
		// has to be refreshed alongside it. Without this the buttons keep
		// announcing the old name until something else repaints the list, which
		// points a screen-reader user at the wrong category.
		const syncMoveLabels = (displayName: string): void => {
			for (const btn of reorder.findAll('.annoteca-category-move')) {
				const d = btn.dataset.annotecaMove;
				if (d !== 'up' && d !== 'down') continue;
				btn.setAttribute('aria-label', moveLabel(d, displayName));
			}
		};

		// Pointer-free reordering. These are the primary path, not a mobile
		// fallback: HTML5 drag-and-drop is equally unusable by keyboard and
		// screen-reader users, so the buttons ship on every platform.
		const moveButton = (
			direction: 'up' | 'down',
			icon: string,
			disabled: boolean,
		): void => {
			const btn = reorder.createEl('button', {
				cls: 'annoteca-category-move',
				attr: {
					type: 'button',
					'data-annoteca-move': direction,
					'aria-label': moveLabel(direction, cat.displayName),
					...(disabled ? { disabled: 'true' } : {}),
				},
			});
			setIcon(btn, icon);
			if (disabled) return;
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.plugin.settings.categories = moveCategory(
					this.plugin.settings.categories,
					cat.id,
					direction,
				);
				this.commitCategoryChange();
				refocusAfterMove(direction);
			});
		};

		moveButton('up', 'chevron-up', isFirst);
		moveButton('down', 'chevron-down', isLast);

		const summary = header.createEl('button', {
			cls: 'annoteca-category-summary',
			attr: {
				type: 'button',
				'aria-expanded': isExpanded ? 'true' : 'false',
			},
		});

		const summaryIcon = summary.createSpan({
			cls: 'annoteca-category-summary-icon',
		});
		if (cat.icon) {
			setIcon(summaryIcon, cat.icon);
		} else {
			summaryIcon.addClass('is-empty');
			summaryIcon.setText('?');
		}

		summary.createSpan({
			cls: 'annoteca-category-summary-name',
			text: cat.displayName,
		});

		const colorDot = summary.createSpan({
			cls: 'annoteca-category-summary-color',
		});
		if (cat.color) {
			colorDot.style.backgroundColor = cat.color;
		} else {
			colorDot.addClass('is-empty');
		}

		summary.createSpan({
			cls: 'annoteca-category-summary-id',
			text: cat.id,
		});

		const chevron = summary.createSpan({
			cls: 'annoteca-category-summary-chevron',
		});
		setIcon(chevron, 'chevron-down');

		// --- Detail panel -----------------------------------------------
		const detail = row.createDiv({ cls: 'annoteca-category-detail' });

		summary.addEventListener('click', () => {
			const nowExpanded = !this.expandedCategoryIds.has(cat.id);
			if (nowExpanded) {
				this.expandedCategoryIds.add(cat.id);
			} else {
				this.expandedCategoryIds.delete(cat.id);
			}
			row.toggleClass('is-expanded', nowExpanded);
			summary.setAttribute(
				'aria-expanded',
				nowExpanded ? 'true' : 'false',
			);
		});

		// Drop target: any row accepts the dragged category and reorders the
		// working list so the dragged entry lands at this row's position.
		row.addEventListener('dragover', (e: DragEvent) => {
			if (!this.draggedCategoryId || this.draggedCategoryId === cat.id)
				return;
			e.preventDefault(); // required for the row to be a valid drop target
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			row.addClass('is-drag-over');
		});
		row.addEventListener('dragleave', () =>
			row.removeClass('is-drag-over'),
		);
		row.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			row.removeClass('is-drag-over');
			const dragId = this.draggedCategoryId;
			this.draggedCategoryId = null;
			if (!dragId || dragId === cat.id) return;
			this.plugin.settings.categories = reorderCategories(
				this.plugin.settings.categories,
				dragId,
				cat.id,
			);
			this.commitCategoryChange();
		});

		const controls = detail.createDiv({
			cls: 'annoteca-category-controls',
		});

		// Identifier, read-only. This is the token that appears in the marker
		// itself (`<!-- annoteca/<id>: ... -->`), so it is the one field a user
		// needs when hand-writing a comment or briefing an AI assistant, and it
		// is not editable because changing it would orphan every existing marker
		// using it. Until now it appeared only in the collapsed summary chip;
		// the narrow-viewport breakpoint hides that chip to make room, so the
		// detail panel is where it has to be reachable from.
		const idWrap = controls.createDiv({
			cls: 'annoteca-category-control',
		});
		idWrap.createDiv({
			cls: 'annoteca-category-control-label',
			text: 'Identifier',
		});
		idWrap.createDiv({
			cls: 'annoteca-category-identifier',
			text: cat.id,
		});

		// Display name editing.
		const nameWrap = controls.createDiv({
			cls: 'annoteca-category-control',
		});
		nameWrap.createDiv({
			cls: 'annoteca-category-control-label',
			text: 'Display name',
		});
		const nameInput = nameWrap.createEl('input', {
			cls: 'annoteca-category-name',
			attr: { type: 'text', value: cat.displayName },
		});
		nameInput.addEventListener('input', () => {
			const v = nameInput.value.trim();
			if (v.length === 0) return;
			cat.displayName = v;
			// Keep the summary label in sync without re-rendering the tab.
			const summaryName = summary.querySelector(
				'.annoteca-category-summary-name',
			);
			if (summaryName) summaryName.setText(v);
			// The reorder buttons name the category too, and they are not
			// rebuilt here either.
			syncMoveLabels(v);
			void this.plugin.saveSettings();
		});

		// Icon picker.
		const iconWrap = controls.createDiv({
			cls: 'annoteca-category-control',
		});
		iconWrap.createDiv({
			cls: 'annoteca-category-control-label',
			text: 'Icon',
		});
		createIconPicker(iconWrap, {
			app: this.app,
			current: cat.icon,
			onChange: async (next) => {
				cat.icon = next;
				await this.plugin.saveSettings();
				// Reflect the change in the summary icon without a re-render.
				summaryIcon.empty();
				summaryIcon.removeClass('is-empty');
				if (next) {
					setIcon(summaryIcon, next);
				} else {
					summaryIcon.addClass('is-empty');
					summaryIcon.setText('?');
				}
			},
		});

		// Color picker.
		const colorWrap = controls.createDiv({
			cls: 'annoteca-category-control',
		});
		colorWrap.createDiv({
			cls: 'annoteca-category-control-label',
			text: 'Color',
		});
		createColorPicker(colorWrap, {
			current: cat.color,
			onChange: async (next) => {
				cat.color = next;
				await this.plugin.saveSettings();
				if (next) {
					colorDot.style.backgroundColor = next;
					colorDot.removeClass('is-empty');
				} else {
					colorDot.style.removeProperty('background-color');
					colorDot.addClass('is-empty');
				}
			},
		});

		// Tier (anchor-underline urgency). Drives the underline's thickness
		// for comments in this category: subtle → thin, normal → uses the
		// global anchor thickness, strong → thick.
		const tierWrap = controls.createDiv({
			cls: 'annoteca-category-control',
		});
		tierWrap.createDiv({
			cls: 'annoteca-category-control-label',
			text: 'Tier',
		});
		const tierSelect = tierWrap.createEl('select', { cls: 'dropdown' });
		tierSelect.createEl('option', {
			value: 'subtle',
			text: 'Subtle — informational',
		});
		tierSelect.createEl('option', {
			value: 'normal',
			text: 'Normal — actionable feedback',
		});
		tierSelect.createEl('option', {
			value: 'strong',
			text: 'Strong — urgent',
		});
		tierSelect.value = cat.tier ?? 'normal';
		tierSelect.addEventListener('change', () => {
			const next = tierSelect.value as 'subtle' | 'normal' | 'strong';
			cat.tier = next === 'normal' ? undefined : next;
			void this.plugin.saveSettings();
		});

		// Actions: either Remove or the protected note.
		const actions = detail.createDiv({ cls: 'annoteca-category-actions' });
		if (isProtected) {
			actions.createDiv({
				cls: 'annoteca-category-protected-note',
				text: 'Used as the scratchpad fallback; this category cannot be removed.',
			});
		} else {
			const removeBtn = actions.createEl('button', {
				cls: 'annoteca-category-remove',
				text: 'Remove category',
				attr: { type: 'button' },
			});
			removeBtn.addEventListener('click', () => {
				if (this.plugin.settings.defaultCategory === cat.id) {
					new Notice(
						'Cannot remove the default category. Pick a different default first.',
					);
					return;
				}
				this.plugin.settings.categories =
					this.plugin.settings.categories.filter(
						(c) => c.id !== cat.id,
					);
				this.expandedCategoryIds.delete(cat.id);
				this.commitCategoryChange();
			});
		}
	}

	// Author/collaborator styling (F-274/F-275). Each row is a tag plus an
	// optional color; the tag list feeds the reply composer's author picker and
	// the color tints that author's name and replies in the thread and hover.
	private renderAuthorStyles(host: HTMLElement): void {
		const { content } = createStackedRow(host, {
			name: 'Collaborators and author colors',
			description:
				"Tags for the people and assistants who reply in this vault. Each one appears in the reply author picker, and its color tints that author's name and replies.",
		});

		const list = content.createDiv({ cls: 'annoteca-author-style-list' });
		for (const style of this.plugin.settings.authorStyles) {
			const row = list.createDiv({ cls: 'annoteca-author-style-row' });
			row.createSpan({
				cls: 'annoteca-author-style-tag',
				text: style.tag,
			});
			const colorWrap = row.createDiv({
				cls: 'annoteca-author-style-color',
			});
			createColorPicker(colorWrap, {
				current: style.color,
				onChange: async (next) => {
					style.color = next;
					await this.plugin.saveSettings();
				},
			});
			const remove = row.createEl('button', {
				cls: 'annoteca-author-style-remove',
				text: 'Remove',
				attr: { type: 'button' },
			});
			remove.addEventListener('click', () => {
				this.plugin.settings.authorStyles =
					this.plugin.settings.authorStyles.filter(
						(s) => s.tag !== style.tag,
					);
				void this.plugin.saveSettings();
				this.rerender();
			});
		}

		const addRow = content.createDiv({ cls: 'annoteca-author-style-add' });
		const input = addRow.createEl('input', {
			cls: 'annoteca-author-style-input',
			attr: { type: 'text', placeholder: 'Author tag' },
		});
		const addBtn = addRow.createEl('button', {
			cls: 'mod-cta',
			text: 'Add author',
			attr: { type: 'button' },
		});
		addBtn.addEventListener('click', () => {
			const tag = input.value.trim();
			if (tag === '') return;
			if (!isAuthorToken(tag)) {
				new Notice(
					'Use a single tag with no spaces (max 32 characters).',
				);
				return;
			}
			if (this.plugin.settings.authorStyles.some((s) => s.tag === tag)) {
				new Notice('That author is already configured.');
				return;
			}
			this.plugin.settings.authorStyles.push({ tag });
			void this.plugin.saveSettings();
			this.rerender();
		});
	}
}
