import {
	App,
	PluginSettingTab,
	Setting,
	Notice,
	ButtonComponent,
	setIcon,
} from "obsidian";

import type AnnotecaPlugin from "./main";
import type { AnnotecaSettings, CategoryDefinition, UserPreset } from "./types";
import {
	DEFAULT_CATEGORIES,
	DEFAULT_PRESETS,
	isValidCategoryName,
	resolveEnabledCategories,
} from "./categories";
import { createStackedRow, createColorPicker, createIconPicker } from "./ui-helpers";

export const DEFAULT_SETTINGS: AnnotecaSettings = {
	categories: DEFAULT_CATEGORIES.map(c => ({ ...c })),
	defaultCategory: "clarify",
	enableScholarlyPreset: false,
	enableIndexEntryPreset: false,

	indicatorStyle: "both",
	defaultVisibility: "show",

	anchorStyle: "wavy",
	anchorThickness: "medium",

	resolvedDisplay: "dim",

	composerLocation: "modal",

	enableAuthorTag: false,
	authorTag: "",

	debugMode: false,
	debugLogTarget: "console",

	settingsBackupPath: undefined,

	starredComments: [],
	lastHubTab: "thread",
	scopeState: {
		shape: { kind: "file" },
		anchorPath: "",
		pinned: false,
	},
	statusFilter: "open",
	autoCollapseInactiveFiles: true,
	customPresets: [],
	indicatorSize: "medium",
};

// Resolve the active category list given current settings. Centralized so the
// modal, decorations, and views consume one source of truth.
export function resolveSettingsCategories(s: AnnotecaSettings): CategoryDefinition[] {
	const base = resolveEnabledCategories(s.categories, s.enableScholarlyPreset);
	if (s.enableIndexEntryPreset && !base.find(c => c.id === "index-entry")) {
		base.push({
			id: "index-entry",
			displayName: "Index entry",
			icon: "list",
			color: "var(--text-accent)",
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

	constructor(app: App, plugin: AnnotecaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderCategoriesSection(containerEl);
		this.renderIndicatorsSection(containerEl);
		this.renderMetadataSection(containerEl);
		this.renderDiagnosticsSection(containerEl);
	}

	private renderCategoriesSection(container: HTMLElement): void {
		new Setting(container)
			.setName("Categories")
			.setHeading();

		this.renderPresetSection(container);

		new Setting(container)
			.setName("Index-entry preset")
			.setDesc("Add an index-entry category for tagging concepts that should appear in a printed index. Pairs with the pandoc filter shipped under docs in the plugin repository.")
			.addToggle(t => t
				.setValue(this.plugin.settings.enableIndexEntryPreset)
				.onChange(async value => {
					this.plugin.settings.enableIndexEntryPreset = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(container)
			.setName("Default category")
			.setDesc("Selected in the add-comment modal by default.")
			.addDropdown(d => {
				const enabled = resolveSettingsCategories(this.plugin.settings);
				for (const c of enabled) d.addOption(c.id, c.displayName);
				d.setValue(this.plugin.settings.defaultCategory);
				d.onChange(async value => {
					this.plugin.settings.defaultCategory = value;
					await this.plugin.saveSettings();
				});
			});

		this.renderCategoryList(container);

		new Setting(container)
			.setName("Add category")
			.setDesc("Lowercase letters, digits, and single dashes. Cannot start or end with a dash. A few format keywords are unavailable as category names.")
			.addText(t => t.setPlaceholder("Fact-check").then(text => {
				let pendingName = "";
				text.onChange(v => { pendingName = v.trim(); });

				new ButtonComponent(text.inputEl.parentElement ?? container)
					.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						if (!pendingName) return;
						if (!isValidCategoryName(pendingName)) {
							new Notice("Invalid category name.");
							return;
						}
						if (this.plugin.settings.categories.some(c => c.id === pendingName)) {
							new Notice("Category already exists.");
							return;
						}
						this.plugin.settings.categories.push({
							id: pendingName,
							displayName: pendingName.charAt(0).toUpperCase() + pendingName.slice(1).replace(/-/g, " "),
						});
						await this.plugin.saveSettings();
						this.display();
					});
			}));

	}

	private renderPresetSection(container: HTMLElement): void {
		const customPresets = this.plugin.settings.customPresets;
		const allPresets: Array<{ id: string; displayName: string; categories: readonly CategoryDefinition[]; isCustom: boolean }> = [
			...DEFAULT_PRESETS.map(p => ({ ...p, isCustom: false })),
			...customPresets.map(p => ({ ...p, isCustom: true })),
		];

		const { content } = createStackedRow(container, {
			name: "Browse presets",
			description: "Cherry-pick categories from any preset into your working list. Picking a preset never replaces existing categories.",
		});

		// Preset selector dropdown.
		const selectorRow = content.createDiv({ cls: "annoteca-preset-selector" });
		const select = selectorRow.createEl("select", { cls: "dropdown" });
		for (const p of allPresets) {
			select.createEl("option", {
				value: p.id,
				text: p.isCustom ? `★ ${p.displayName}` : p.displayName,
			});
		}

		// Preview of selected preset's categories with checkboxes.
		const previewArea = content.createDiv({ cls: "annoteca-preset-preview" });

		const renderPreview = (): void => {
			previewArea.empty();
			const selected = allPresets.find(p => p.id === select.value);
			if (!selected) return;
			const existingIds = new Set(this.plugin.settings.categories.map(c => c.id));
			const checks: Array<{ cat: CategoryDefinition; input: HTMLInputElement; conflict: boolean }> = [];

			for (const cat of selected.categories) {
				const conflict = existingIds.has(cat.id);
				const row = previewArea.createDiv({
					cls: `annoteca-preset-cat${conflict ? " is-conflict" : ""}`,
				});
				const input = row.createEl("input", { attr: { type: "checkbox" } });
				input.disabled = conflict;
				const label = row.createSpan({ cls: "annoteca-preset-cat-label" });
				if (cat.icon) {
					const iconEl = label.createSpan({ cls: "annoteca-preset-cat-icon" });
					setIcon(iconEl, cat.icon);
				}
				label.createSpan({ text: cat.displayName });
				if (conflict) {
					row.createSpan({ cls: "annoteca-preset-conflict", text: "already in list" });
				}
				checks.push({ cat, input, conflict });
			}

			const actions = previewArea.createDiv({ cls: "annoteca-preset-actions" });
			const addBtn = actions.createEl("button", {
				cls: "annoteca-preset-add mod-cta",
				text: "Add selected categories",
				attr: { type: "button" },
			});
			addBtn.addEventListener("click", () => {
				const chosen = checks.filter(c => !c.conflict && c.input.checked).map(c => c.cat);
				if (chosen.length === 0) {
					new Notice("Pick at least one category.");
					return;
				}
				this.plugin.settings.categories.push(...chosen.map(c => ({ ...c })));
				void this.plugin.saveSettings();
				new Notice(`Added ${chosen.length} categor${chosen.length === 1 ? "y" : "ies"}.`);
				this.display();
			});

			if (selected.isCustom) {
				const deleteBtn = actions.createEl("button", {
					cls: "annoteca-preset-delete",
					text: "Delete preset",
					attr: { type: "button" },
				});
				deleteBtn.addEventListener("click", () => {
					this.plugin.settings.customPresets =
						this.plugin.settings.customPresets.filter(p => p.id !== selected.id);
					void this.plugin.saveSettings();
					this.display();
				});
			}
		};

		select.addEventListener("change", renderPreview);
		renderPreview();

		// Save current categories as a custom preset.
		const { content: saveContent } = createStackedRow(container, {
			name: "Save current as preset",
			description: "Capture your current working categories under a name so you can reuse them later or share between vaults.",
		});
		const saveRow = saveContent.createDiv({ cls: "annoteca-preset-save" });
		const nameInput = saveRow.createEl("input", {
			cls: "annoteca-preset-save-name",
			attr: { type: "text", placeholder: "Preset name" },
		});
		const saveBtn = saveRow.createEl("button", {
			cls: "annoteca-preset-save-button mod-cta",
			text: "Save",
			attr: { type: "button" },
		});
		saveBtn.addEventListener("click", () => {
			const name = nameInput.value.trim();
			if (name.length === 0) {
				new Notice("Give the preset a name.");
				return;
			}
			const id = `user-${Date.now().toString(36)}`;
			const preset: UserPreset = {
				id,
				displayName: name,
				categories: this.plugin.settings.categories.map(c => ({ ...c })),
			};
			this.plugin.settings.customPresets.push(preset);
			void this.plugin.saveSettings();
			new Notice(`Saved preset “${name}”.`);
			this.display();
		});
	}

	private renderCategoryList(container: HTMLElement): void {
		const list = container.createDiv({ cls: "annoteca-category-list" });
		for (const cat of this.plugin.settings.categories) {
			this.renderCategoryRow(list, cat);
		}
	}

	// Accordion row: collapsed summary (icon + name + color dot + identifier
	// + chevron) plus a hidden detail panel with the full editor. Expansion
	// state lives in `expandedCategoryIds` so it survives re-renders.
	private renderCategoryRow(list: HTMLElement, cat: CategoryDefinition): void {
		const isProtected = cat.id === "uncategorized";
		const isExpanded = this.expandedCategoryIds.has(cat.id);

		const row = list.createDiv({
			cls: `annoteca-category-row${isExpanded ? " is-expanded" : ""}`,
		});

		// --- Summary row ------------------------------------------------
		const summary = row.createEl("button", {
			cls: "annoteca-category-summary",
			attr: {
				type: "button",
				"aria-expanded": isExpanded ? "true" : "false",
			},
		});

		const summaryIcon = summary.createSpan({ cls: "annoteca-category-summary-icon" });
		if (cat.icon) {
			setIcon(summaryIcon, cat.icon);
		} else {
			summaryIcon.addClass("is-empty");
			summaryIcon.setText("?");
		}

		summary.createSpan({
			cls: "annoteca-category-summary-name",
			text: cat.displayName,
		});

		const colorDot = summary.createSpan({ cls: "annoteca-category-summary-color" });
		if (cat.color) {
			colorDot.style.backgroundColor = cat.color;
		} else {
			colorDot.addClass("is-empty");
		}

		summary.createSpan({
			cls: "annoteca-category-summary-id",
			text: cat.id,
		});

		const chevron = summary.createSpan({ cls: "annoteca-category-summary-chevron" });
		setIcon(chevron, "chevron-down");

		// --- Detail panel -----------------------------------------------
		const detail = row.createDiv({ cls: "annoteca-category-detail" });

		summary.addEventListener("click", () => {
			const nowExpanded = !this.expandedCategoryIds.has(cat.id);
			if (nowExpanded) {
				this.expandedCategoryIds.add(cat.id);
			} else {
				this.expandedCategoryIds.delete(cat.id);
			}
			row.toggleClass("is-expanded", nowExpanded);
			summary.setAttribute("aria-expanded", nowExpanded ? "true" : "false");
		});

		const controls = detail.createDiv({ cls: "annoteca-category-controls" });

		// Display name editing.
		const nameWrap = controls.createDiv({ cls: "annoteca-category-control" });
		nameWrap.createDiv({ cls: "annoteca-category-control-label", text: "Display name" });
		const nameInput = nameWrap.createEl("input", {
			cls: "annoteca-category-name",
			attr: { type: "text", value: cat.displayName },
		});
		nameInput.addEventListener("input", () => {
			const v = nameInput.value.trim();
			if (v.length === 0) return;
			cat.displayName = v;
			// Keep the summary label in sync without re-rendering the tab.
			const summaryName = summary.querySelector(".annoteca-category-summary-name");
			if (summaryName) summaryName.setText(v);
			void this.plugin.saveSettings();
		});

		// Icon picker.
		const iconWrap = controls.createDiv({ cls: "annoteca-category-control" });
		iconWrap.createDiv({ cls: "annoteca-category-control-label", text: "Icon" });
		createIconPicker(iconWrap, {
			app: this.app,
			current: cat.icon,
			onChange: async next => {
				cat.icon = next;
				await this.plugin.saveSettings();
				// Reflect the change in the summary icon without a re-render.
				summaryIcon.empty();
				summaryIcon.removeClass("is-empty");
				if (next) {
					setIcon(summaryIcon, next);
				} else {
					summaryIcon.addClass("is-empty");
					summaryIcon.setText("?");
				}
			},
		});

		// Color picker.
		const colorWrap = controls.createDiv({ cls: "annoteca-category-control" });
		colorWrap.createDiv({ cls: "annoteca-category-control-label", text: "Color" });
		createColorPicker(colorWrap, {
			current: cat.color,
			onChange: async next => {
				cat.color = next;
				await this.plugin.saveSettings();
				if (next) {
					colorDot.style.backgroundColor = next;
					colorDot.removeClass("is-empty");
				} else {
					colorDot.style.removeProperty("background-color");
					colorDot.addClass("is-empty");
				}
			},
		});

		// Tier (anchor-underline urgency). Drives the underline's thickness
		// for comments in this category: subtle → thin, normal → uses the
		// global anchor thickness, strong → thick.
		const tierWrap = controls.createDiv({ cls: "annoteca-category-control" });
		tierWrap.createDiv({ cls: "annoteca-category-control-label", text: "Tier" });
		const tierSelect = tierWrap.createEl("select", { cls: "dropdown" });
		tierSelect.createEl("option", { value: "subtle", text: "Subtle — informational" });
		tierSelect.createEl("option", { value: "normal", text: "Normal — actionable feedback" });
		tierSelect.createEl("option", { value: "strong", text: "Strong — urgent" });
		tierSelect.value = cat.tier ?? "normal";
		tierSelect.addEventListener("change", () => {
			const next = tierSelect.value as "subtle" | "normal" | "strong";
			cat.tier = next === "normal" ? undefined : next;
			void this.plugin.saveSettings();
		});

		// Actions: either Remove or the protected note.
		const actions = detail.createDiv({ cls: "annoteca-category-actions" });
		if (isProtected) {
			actions.createDiv({
				cls: "annoteca-category-protected-note",
				text: "Used as the scratchpad fallback; this category cannot be removed.",
			});
		} else {
			const removeBtn = actions.createEl("button", {
				cls: "annoteca-category-remove",
				text: "Remove category",
				attr: { type: "button" },
			});
			removeBtn.addEventListener("click", () => {
				if (this.plugin.settings.defaultCategory === cat.id) {
					new Notice("Cannot remove the default category. Pick a different default first.");
					return;
				}
				this.plugin.settings.categories =
					this.plugin.settings.categories.filter(c => c.id !== cat.id);
				this.expandedCategoryIds.delete(cat.id);
				void this.plugin.saveSettings();
				this.display();
			});
		}
	}

	private renderIndicatorsSection(container: HTMLElement): void {
		new Setting(container).setName("Indicators").setHeading();

		new Setting(container)
			.setName("Indicator style")
			.setDesc("How comments are surfaced in the editor. The underline marks the text the comment was made against. The icon marks the comment's location when no text was selected at create time.")
			.addDropdown(d => d
				.addOption("icon", "Inline icon only")
				.addOption("underline", "Anchor underline only")
				.addOption("both", "Icon and underline")
				.addOption("none", "Hidden")
				.setValue(this.plugin.settings.indicatorStyle)
				.onChange(async value => {
					this.plugin.settings.indicatorStyle = value as AnnotecaSettings["indicatorStyle"];
					await this.plugin.saveSettings();
				}));

		new Setting(container)
			.setName("Indicator size")
			.setDesc("Visual size of the marker icon in the editor.")
			.addDropdown(d => d
				.addOption("small", "Small")
				.addOption("medium", "Medium")
				.addOption("large", "Large")
				.setValue(this.plugin.settings.indicatorSize)
				.onChange(async value => {
					this.plugin.settings.indicatorSize = value as AnnotecaSettings["indicatorSize"];
					await this.plugin.saveSettings();
					this.plugin.applyIndicatorSize();
				}));

		new Setting(container)
			.setName("Anchor underline style")
			.setDesc("Visual character of the underline drawn over commented text. Applies to every category.")
			.addDropdown(d => d
				.addOption("wavy", "Wavy")
				.addOption("solid", "Solid")
				.addOption("dotted", "Dotted")
				.addOption("dashed", "Dashed")
				.setValue(this.plugin.settings.anchorStyle)
				.onChange(async value => {
					this.plugin.settings.anchorStyle = value as AnnotecaSettings["anchorStyle"];
					await this.plugin.saveSettings();
					this.plugin.applyAnchorAppearance();
				}));

		new Setting(container)
			.setName("Anchor underline thickness")
			.setDesc("Baseline thickness for categories on the normal tier. Subtle always renders thin, strong always renders thick, regardless of this setting.")
			.addDropdown(d => d
				.addOption("thin", "Thin")
				.addOption("medium", "Medium")
				.addOption("thick", "Thick")
				.setValue(this.plugin.settings.anchorThickness)
				.onChange(async value => {
					this.plugin.settings.anchorThickness = value as AnnotecaSettings["anchorThickness"];
					await this.plugin.saveSettings();
					this.plugin.applyAnchorAppearance();
				}));

		new Setting(container)
			.setName("Default visibility on file open")
			.setDesc("Whether comments are visible when a file opens.")
			.addDropdown(d => d
				.addOption("show", "Show")
				.addOption("hide", "Hide")
				.addOption("last", "Last state")
				.setValue(this.plugin.settings.defaultVisibility)
				.onChange(async value => {
					this.plugin.settings.defaultVisibility = value as AnnotecaSettings["defaultVisibility"];
					await this.plugin.saveSettings();
				}));

		new Setting(container)
			.setName("Resolved comment display")
			.setDesc("How resolved comments appear in the editor.")
			.addDropdown(d => d
				.addOption("dim", "Dim")
				.addOption("hide", "Hide")
				.setValue(this.plugin.settings.resolvedDisplay)
				.onChange(async value => {
					this.plugin.settings.resolvedDisplay = value as AnnotecaSettings["resolvedDisplay"];
					await this.plugin.saveSettings();
				}));

		new Setting(container)
			.setName("Composer location")
			.setDesc("Where the add-comment form appears. The side panel keeps the document visible while you draft.")
			.addDropdown(d => d
				.addOption("modal", "Modal dialog")
				.addOption("panel", "Right side panel")
				.setValue(this.plugin.settings.composerLocation)
				.onChange(async value => {
					this.plugin.settings.composerLocation = value as AnnotecaSettings["composerLocation"];
					await this.plugin.saveSettings();
				}));

		new Setting(container)
			.setName("Auto-collapse other files in scope")
			.setDesc("When the thread panel shows comments from multiple files, collapse files other than the one you are editing. Click a file header to expand it manually.")
			.addToggle(t => t
				.setValue(this.plugin.settings.autoCollapseInactiveFiles)
				.onChange(async value => {
					this.plugin.settings.autoCollapseInactiveFiles = value;
					await this.plugin.saveSettings();
				}));
	}

	private renderMetadataSection(container: HTMLElement): void {
		new Setting(container).setName("Metadata").setHeading();

		new Setting(container)
			.setName("Author tag")
			.setDesc("When enabled, new comments include an [author=...] line. Useful when collaborating with an AI agent or multiple reviewers.")
			.addToggle(t => t
				.setValue(this.plugin.settings.enableAuthorTag)
				.onChange(async value => {
					this.plugin.settings.enableAuthorTag = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.enableAuthorTag) {
			new Setting(container)
				.setName("Author identifier")
				.setDesc("Short tag. Lowercase letters, digits, and dashes; maximum 32 characters.")
				.addText(t => t
					.setPlaceholder("Charles")
					.setValue(this.plugin.settings.authorTag)
					.onChange(async value => {
						const v = value.trim().toLowerCase();
						if (v !== "" && !/^[a-z0-9-]{1,32}$/.test(v)) {
							new Notice("Invalid author tag. Use lowercase letters, digits, and dashes (max 32).");
							return;
						}
						this.plugin.settings.authorTag = v;
						await this.plugin.saveSettings();
					}));
		}
	}

	private renderDiagnosticsSection(container: HTMLElement): void {
		new Setting(container).setName("Diagnostics").setHeading();

		new Setting(container)
			.setName("Debug mode")
			.setDesc("Log additional information for troubleshooting. Off by default to avoid log spam.")
			.addToggle(t => t
				.setValue(this.plugin.settings.debugMode)
				.onChange(async value => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.debugMode) {
			new Setting(container)
				.setName("Debug log destination")
				.setDesc("Where diagnostic output is written.")
				.addDropdown(d => d
					.addOption("console", "Browser console")
					.addOption("vault", "Log file in the vault")
					.setValue(this.plugin.settings.debugLogTarget)
					.onChange(async value => {
						this.plugin.settings.debugLogTarget = value as AnnotecaSettings["debugLogTarget"];
						await this.plugin.saveSettings();
					}));
		}
	}
}
