import {
	App,
	PluginSettingTab,
	Setting,
	Notice,
	ButtonComponent,
} from "obsidian";

import type AnnotecaPlugin from "./main";
import type { AnnotecaSettings, CategoryDefinition } from "./types";
import {
	DEFAULT_CATEGORIES,
	SCHOLARLY_PRESET_CATEGORIES,
	isValidCategoryName,
	resolveEnabledCategories,
} from "./categories";

export const DEFAULT_SETTINGS: AnnotecaSettings = {
	categories: DEFAULT_CATEGORIES.map(c => ({ ...c })),
	defaultCategory: "clarify",
	enableScholarlyPreset: false,
	enableIndexEntryPreset: false,

	indicatorStyle: "both",
	defaultVisibility: "show",

	resolvedDisplay: "dim",

	enableAuthorTag: false,
	authorTag: "",

	debugMode: false,
	debugLogTarget: "console",

	settingsBackupPath: undefined,
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

		new Setting(container)
			.setName("Scholarly preset")
			.setDesc("Add verse-needed and meditation to the category list. Useful for theology and scripture-heavy documents.")
			.addToggle(t => t
				.setValue(this.plugin.settings.enableScholarlyPreset)
				.onChange(async value => {
					this.plugin.settings.enableScholarlyPreset = value;
					await this.plugin.saveSettings();
					this.display();
				}));

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

		if (this.plugin.settings.enableScholarlyPreset) {
			new Setting(container)
				.setName("Scholarly preset categories")
				.setDesc(SCHOLARLY_PRESET_CATEGORIES.map(c => c.displayName).join(", "));
		}
	}

	private renderCategoryList(container: HTMLElement): void {
		const list = container.createDiv({ cls: "annoteca-category-list" });
		for (const cat of this.plugin.settings.categories) {
			const row = new Setting(list)
				.setName(cat.displayName)
				.setDesc(`Identifier: ${cat.id}`);

			row.addText(t => t
				.setPlaceholder("Icon name")
				.setValue(cat.icon ?? "")
				.onChange(async value => {
					cat.icon = value.trim() === "" ? undefined : value.trim();
					await this.plugin.saveSettings();
				}));

			row.addText(t => t
				.setPlaceholder("CSS color or variable")
				.setValue(cat.color ?? "")
				.onChange(async value => {
					cat.color = value.trim() === "" ? undefined : value.trim();
					await this.plugin.saveSettings();
				}));

			row.addButton(b => b
				.setIcon("trash-2")
				.setTooltip("Remove category")
				.onClick(async () => {
					if (cat.id === "uncategorized") {
						new Notice("The uncategorized category cannot be removed (used by the scratchpad).");
						return;
					}
					if (this.plugin.settings.defaultCategory === cat.id) {
						new Notice("Cannot remove the default category. Pick a different default first.");
						return;
					}
					this.plugin.settings.categories =
						this.plugin.settings.categories.filter(c => c.id !== cat.id);
					await this.plugin.saveSettings();
					this.display();
				}));
		}
	}

	private renderIndicatorsSection(container: HTMLElement): void {
		new Setting(container).setName("Indicators").setHeading();

		new Setting(container)
			.setName("Indicator style")
			.setDesc("Where comment indicators appear in the editor.")
			.addDropdown(d => d
				.addOption("gutter", "Gutter icon only")
				.addOption("inline", "Inline underline only")
				.addOption("both", "Gutter and inline")
				.addOption("none", "Hidden")
				.setValue(this.plugin.settings.indicatorStyle)
				.onChange(async value => {
					this.plugin.settings.indicatorStyle = value as AnnotecaSettings["indicatorStyle"];
					await this.plugin.saveSettings();
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
