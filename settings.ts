import {
	App,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	Notice,
	ButtonComponent,
	setIcon,
	requireApiVersion,
} from 'obsidian';

import type AnnotecaPlugin from './main';
import type { AnnotecaSettings, CategoryDefinition, UserPreset } from './types';
import {
	DEFAULT_CATEGORIES,
	DEFAULT_PRESETS,
	isValidCategoryName,
	resolveEnabledCategories,
	reorderCategories,
	moveCategory,
} from './categories';
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
// restored backup, so a stored value is not guaranteed to be the type it was
// written as. Every read of this setting is a truthiness test, so a stored
// string "false" would silently turn a disabled setting back on.
//
// Both entry points go through here on purpose. Normalizing only on load left
// the restore path spreading parsed JSON straight into the live settings, so a
// backup file could reintroduce exactly the value the load path exists to
// reject.
//
// The fallback is a parameter because ABSENT and WRONG TYPE are different
// questions. Absent means the stored blob simply does not carry the key, and
// the answer is whatever the surrounding spread already settled on: the default
// on load, the current live value on restore. Only a present-but-non-boolean
// value is a rejection.
export function normalizeRenderMarkdownBodies(
	stored: unknown,
	fallback: boolean,
): boolean {
	return typeof stored === 'boolean' ? stored : fallback;
}

// The whole "restore settings from a backup file" merge, in one pure function.
//
// It lives here rather than inline in the plugin method for a reason found by
// mutation: with the merge inline, deleting the normalizing entirely left the
// suite green, because no test reaches main.ts at runtime. A normalizer nothing
// can test is a normalizer that quietly stops running.
//
// Precedence is the same as the inline spread it replaces. Defaults fill gaps,
// the live settings win over those, and the backup wins over both, because
// restoring is an explicit request to take the file's values.
export function mergeRestoredSettings(
	current: AnnotecaSettings,
	parsed: Partial<AnnotecaSettings>,
): AnnotecaSettings {
	return {
		...DEFAULT_SETTINGS,
		...current,
		...parsed,
		renderMarkdownBodies: normalizeRenderMarkdownBodies(
			parsed.renderMarkdownBodies,
			current.renderMarkdownBodies,
		),
	};
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
								return v === '' || /^[^\s\]<>]{1,32}$/.test(v)
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

	// Imperative settings tab for Obsidian < 1.13.0 (dual-support Path B from the
	// Obsidian "Migrate to declarative settings" guide). On 1.13.0+ Obsidian
	// renders from getSettingDefinitions() and skips display() entirely; older
	// builds have no knowledge of getSettingDefinitions() and call display().
	//
	// This method and its row helpers use ONLY pre-1.13 Obsidian APIs and never
	// reference the declarative SettingDefinition* types (which are imported
	// type-only, so they leave no runtime trace in main.js): the marketplace
	// no-unsupported-api scan rejects any 1.13.0 API reference while
	// minAppVersion is below 1.13.0. The one 1.13 method, update(), is reached
	// only through rerender(), guarded by requireApiVersion so it never runs on
	// older builds. This path mirrors getSettingDefinitions() above; any change
	// to one must be mirrored in the other or users on different Obsidian
	// versions will see different settings.
	//
	// display() is marked deprecated in the 1.13 types because the declarative
	// API supersedes it, but Obsidian still calls it on < 1.13 builds. It only
	// delegates to renderImperativeSettings(), so our own code never calls the
	// deprecated method (rerender() calls renderImperativeSettings() directly).
	// That keeps the build free of any @typescript-eslint/no-deprecated use, so
	// there is nothing to suppress.
	display(): void {
		this.renderImperativeSettings();
	}

	private renderImperativeSettings(): void {
		const { containerEl } = this;
		containerEl.empty();

		const categoryOptions: Record<string, string> = {};
		for (const c of resolveSettingsCategories(this.plugin.settings)) {
			categoryOptions[c.id] = c.displayName;
		}

		// Categories
		this.heading(containerEl, 'Categories');
		this.renderCustomBlock(containerEl, (host) =>
			this.renderPresetSection(host),
		);
		this.addToggleRow(
			containerEl,
			'Index-entry preset',
			'Add an index-entry category for tagging concepts that should appear in a printed index. Pairs with the pandoc filter shipped under docs in the plugin repository.',
			'enableIndexEntryPreset',
		);
		this.addDropdownRow(
			containerEl,
			'Default category',
			'Selected in the add-comment modal by default.',
			'defaultCategory',
			categoryOptions,
		);
		this.renderCustomBlock(containerEl, (host) =>
			this.renderCategoryList(host),
		);
		this.renderCustomBlock(containerEl, (host) =>
			this.renderAddCategory(host),
		);

		// Editor indicators
		this.heading(containerEl, 'Editor indicators');
		this.addDropdownRow(
			containerEl,
			'Indicator style',
			"How comments are surfaced in the editor. The underline marks the text the comment was made against. The icon marks the comment's location when no text was selected at create time.",
			'indicatorStyle',
			{
				icon: 'Inline icon only',
				underline: 'Anchor underline only',
				both: 'Icon and underline',
				none: 'Hidden',
			},
		);
		this.addDropdownRow(
			containerEl,
			'Indicator size',
			'Visual size of the marker icon in the editor.',
			'indicatorSize',
			{ small: 'Small', medium: 'Medium', large: 'Large' },
		);
		this.addToggleRow(
			containerEl,
			'Marker hover preview',
			'Show a preview of the comment and its thread when you hover a marker or its underline in the editor. Turn off to rely on clicking the marker to open the side panel.',
			'hoverPreview',
		);
		this.addDropdownRow(
			containerEl,
			'Hover preview delay',
			'How long to hover before the preview appears. Takes effect after reloading the plugin.',
			'hoverDelay',
			{
				instant: 'Instant',
				short: 'Short',
				default: 'Default',
				relaxed: 'Relaxed',
			},
		);
		this.addDropdownRow(
			containerEl,
			'Clicking a marker',
			'What happens when you click or tap a marker in the editor. Open in side panel shows the full thread; Show popover keeps the document in view. Defaults to the popover on phones and tablets, where there is no hover preview.',
			'markerClickAction',
			{
				panel: 'Open in side panel',
				popover: 'Show popover',
			},
		);
		this.addToggleRow(
			containerEl,
			'Render Markdown in comments',
			'Show comment bodies, replies and notes as formatted Markdown in the marker popover and the Hub panel, instead of their raw source. Links, emphasis, code and lists render. The one-line body shown beside a marker in the editor stays plain text either way, so it cannot reflow the document.',
			'renderMarkdownBodies',
		);
		this.addToggleRow(
			containerEl,
			'Reply count on markers',
			'Show how many replies a thread has next to its marker icon in the editor. Markers with no replies are unchanged.',
			'markerReplyCount',
		);
		this.addDropdownRow(
			containerEl,
			'Anchor underline style',
			'Visual character of the underline drawn over commented text. Applies to every category.',
			'anchorStyle',
			{
				wavy: 'Wavy',
				solid: 'Solid',
				dotted: 'Dotted',
				dashed: 'Dashed',
			},
		);
		this.addDropdownRow(
			containerEl,
			'Anchor underline thickness',
			'Baseline thickness for categories on the normal tier. Subtle always renders thin, strong always renders thick, regardless of this setting.',
			'anchorThickness',
			{ thin: 'Thin', medium: 'Medium', thick: 'Thick' },
		);
		this.addDropdownRow(
			containerEl,
			'Default visibility on file open',
			'Whether comments are visible when a file opens.',
			'defaultVisibility',
			{ show: 'Show', hide: 'Hide', last: 'Last state' },
		);

		this.heading(containerEl, 'Resolved comments');
		this.addDropdownRow(
			containerEl,
			'Resolved comment display',
			'How resolved comments appear in the editor.',
			'resolvedDisplay',
			{ dim: 'Dim', hide: 'Hide' },
		);
		this.addToggleRow(
			containerEl,
			'Delete on resolve',
			'Resolving a comment permanently removes it from the file instead of keeping it as a dimmed [resolved] marker. The thread and its replies are gone; rely on git or backups for history. The separate "Resolve and remove" action always asks first; with this on, plain Resolve removes without asking.',
			'deleteOnResolve',
		);
		this.addDropdownRow(
			containerEl,
			'Resolved brightness',
			'How aggressively resolved comments are dimmed. Normal works well in light themes; bright keeps resolved content legible against dark backgrounds where the base text is already muted.',
			'resolvedBrightness',
			{ normal: 'Normal', bright: 'Bright' },
		);

		this.heading(containerEl, 'Composer');
		this.addDropdownRow(
			containerEl,
			'Composer location',
			'Where the add-comment form appears. The side panel keeps the document visible while you draft.',
			'composerLocation',
			{ modal: 'Modal dialog', panel: 'Right side panel' },
		);
		this.addToggleRow(
			containerEl,
			'Send comment on Enter',
			'When on, Enter sends the comment and Shift+Enter starts a new line. When off, send with Cmd or Ctrl plus Enter, and Enter starts a new line. Applies to the comment box and the reply box.',
			'submitCommentOnEnter',
		);
		this.addToggleRow(
			containerEl,
			'Selection comment button',
			'Show a floating Comment button next to text you select in the editor, so you can start a comment with one click instead of the right-click menu. The Add comment here and Add comment for selection commands can also be bound to a hotkey.',
			'selectionPopup',
		);

		this.heading(containerEl, 'Reading view');
		this.addDropdownRow(
			containerEl,
			'Reading view indicator',
			'Comments are invisible in reading view (markers are HTML comments). Show a note-level banner with totals, a badge on each section that has comments, or both. Click an indicator to open the comment panel. Counts are threads; replies are not counted.',
			'readingViewIndicator',
			{
				off: 'Off',
				banner: 'Note banner',
				'per-section': 'Per-section badges',
				both: 'Banner and badges',
			},
		);

		this.heading(containerEl, 'Panel and navigation');
		this.addToggleRow(
			containerEl,
			'Auto-collapse other files in scope',
			'When the thread panel shows comments from multiple files, collapse files other than the one you are editing. Click a file header to expand it manually.',
			'autoCollapseInactiveFiles',
		);
		this.addDropdownRow(
			containerEl,
			'Marker position when navigating',
			"Where a comment's marker lands in the editor when you jump to it. Top anchors it near the top of the pane for a predictable reading spot. Center puts it in the middle. Minimal scrolls the least needed and stays put if the marker is already visible, so opening the panel does not move your place.",
			'markerScrollAlign',
			{
				top: 'Top of pane',
				center: 'Center',
				minimal: "Minimal (don't move if visible)",
			},
		);

		// Authors
		this.heading(containerEl, 'Authors');
		this.addToggleRow(
			containerEl,
			'Author tag',
			'When enabled, new comments include an [author=...] line. Useful when collaborating with an AI agent or multiple reviewers.',
			'enableAuthorTag',
		);
		if (this.plugin.settings.enableAuthorTag) {
			this.addTextRow(
				containerEl,
				'Author identifier',
				'Short tag with no spaces; maximum 32 characters.',
				'authorTag',
				'reviewer',
				(value: string) => {
					const v = value.trim();
					return v === '' || /^[^\s\]<>]{1,32}$/.test(v)
						? undefined
						: 'Use a single tag with no spaces (max 32 characters).';
				},
			);
		}
		this.renderCustomBlock(containerEl, (host) =>
			this.renderAuthorStyles(host),
		);

		// AI integration
		this.heading(containerEl, 'AI integration');
		this.addDropdownRow(
			containerEl,
			'Skill export destination',
			'Vault folder the exported skill file is written to. Claude Code reads .claude/skills; some other assistants read a .agent folder.',
			'skillExportTarget',
			{
				claude: '.claude/skills (Claude Code)',
				agent: '.agent/skills (other assistants)',
				both: 'Both folders',
			},
		);
		this.renderCustomBlock(containerEl, (host) =>
			this.renderSkillExport(host),
		);

		// Diagnostics
		this.heading(containerEl, 'Diagnostics');
		this.addToggleRow(
			containerEl,
			'Debug mode',
			'Log additional information for troubleshooting. Off by default to avoid log spam.',
			'debugMode',
		);
		if (this.plugin.settings.debugMode) {
			this.addDropdownRow(
				containerEl,
				'Debug log destination',
				'Where diagnostic output is written.',
				'debugLogTarget',
				{ console: 'Browser console', vault: 'Log file in the vault' },
			);
		}
		this.renderCustomBlock(containerEl, (host) => this.renderFooter(host));
	}

	// Re-render after a data change. On 1.13.0+ Obsidian owns the declarative
	// tree, so call update(); on older builds re-run the imperative display().
	// update() is the only 1.13 method touched anywhere in this tab and is
	// reached solely through this guard.
	private rerender(): void {
		if (requireApiVersion('1.13.0')) {
			// 1.13+ owns the declarative tree; update() is the new (non-deprecated)
			// re-render entry point.
			this.update();
		} else {
			// < 1.13: re-render the imperative tree directly. Calling the shared
			// renderer (not the deprecated display()) avoids any no-deprecated use.
			this.renderImperativeSettings();
		}
	}

	private heading(container: HTMLElement, text: string): void {
		new Setting(container).setName(text).setHeading();
	}

	// Read a control value as a display string for dropdown/text rows. Mirrors
	// getControlValue()'s coercion and avoids stringifying a non-primitive.
	private controlString(key: string): string {
		const value = this.getControlValue(key);
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean')
			return String(value);
		return '';
	}

	// Imperative row helpers used only by display(). Each binds through the same
	// getControlValue() / setControlValue() the declarative path uses, so
	// coercion and side effects stay in one place.
	private addToggleRow(
		container: HTMLElement,
		name: string,
		desc: string,
		key: string,
	): void {
		new Setting(container)
			.setName(name)
			.setDesc(desc)
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.getControlValue(key)))
					.onChange((value) => {
						void this.setControlValue(key, value);
					}),
			);
	}

	private addDropdownRow(
		container: HTMLElement,
		name: string,
		desc: string,
		key: string,
		options: Record<string, string>,
	): void {
		new Setting(container)
			.setName(name)
			.setDesc(desc)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(options)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.controlString(key)).onChange((value) => {
					void this.setControlValue(key, value);
				});
			});
	}

	private addTextRow(
		container: HTMLElement,
		name: string,
		desc: string,
		key: string,
		placeholder: string,
		validate?: (value: string) => string | undefined,
	): void {
		new Setting(container)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(this.controlString(key))
					.onChange((value) => {
						if (validate) {
							const error = validate(value);
							if (error) {
								new Notice(error);
								return;
							}
						}
						void this.setControlValue(key, value);
					}),
			);
	}

	// Wraps a custom block in a full-width row, reusing the same builder the
	// declarative path runs via customBlock().render().
	private renderCustomBlock(
		container: HTMLElement,
		build: (host: HTMLElement) => void,
	): void {
		this.customBlock(build).render(new Setting(container));
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

	// Routes declarative controls to the plugin's own settings store and runs the
	// side effects the imperative onChange handlers used to run inline. authorTag
	// is trimmed but keeps its casing (the parser accepts mixed-case authors).
	// Toggles that show or hide dependent rows, or that change the default-category
	// options, trigger a full re-render via update().
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
		await this.plugin.saveSettings();

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
				this.rerender();
				break;
		}
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
	// The two repaints are not interchangeable and both are needed: the custom
	// block does not refresh via update(), so the rows are repainted directly,
	// and rerender() then reconciles the bound default-category dropdown against
	// the new list. Reorder, remove, and move-button all need exactly this, so it
	// lives here rather than being written out at each call site where the two
	// steps could drift apart.
	private commitCategoryChange(list: HTMLElement): void {
		void this.plugin.saveSettings();
		this.refreshCategoryList(list);
		this.rerender();
	}

	// Repaint the category rows into their existing list element. Used after a
	// reorder or remove. We refresh the list directly instead of calling
	// rerender(): on the 1.13 declarative path, update() reconciles bound
	// controls (the default-category dropdown) from fresh definitions but does
	// NOT re-invoke a custom block's render callback, so the list would not
	// repaint until the settings pane was reopened. `list` stays attached
	// because nothing here rebuilds the host around it.
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
		// Which element is live depends on the Obsidian version, because the two
		// rerender() paths differ. On 1.13+ update() leaves this custom block
		// alone, so `list` is still the real element. On older builds rerender()
		// empties containerEl and rebuilds the whole tree, so `list` is detached
		// and the live row is a different node. Checking isConnected picks the
		// right one either way; focus() on a detached node is a silent no-op, so
		// getting this wrong would look like the feature simply not working.
		const refocusAfterMove = (direction: 'up' | 'down'): void => {
			let moved: HTMLElement | undefined;
			for (const root of [list, this.containerEl]) {
				const found = root
					.findAll('.annoteca-category-row')
					.find((r) => r.dataset.annotecaCategory === cat.id);
				if (found?.isConnected) {
					moved = found;
					break;
				}
			}
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
				this.commitCategoryChange(list);
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
			this.commitCategoryChange(list);
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
				this.commitCategoryChange(list);
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
			if (!/^[^\s\]<>]{1,32}$/.test(tag)) {
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
