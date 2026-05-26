// Shared UI building blocks used by settings, composer, and other forms.
// Centralized here so the "stacked row" convention (label above, control
// below) is reused consistently across the plugin instead of fighting
// Obsidian's right-rail Setting widget for long controls like textareas
// and multi-control rows.

import { App, Modal, setIcon, getIconIds } from "obsidian";

export interface StackedRowOpts {
	name: string;
	description?: string;
	cls?: string;
}

export interface StackedRow {
	row: HTMLDivElement;
	content: HTMLDivElement;
}

// Build a stacked row: title + optional description on top, content area
// below for full-width controls. Use this for textareas, multi-control
// composite rows (color + icon picker), and anything else that does not
// fit comfortably in Obsidian's Setting right-rail layout.
export function createStackedRow(parent: HTMLElement, opts: StackedRowOpts): StackedRow {
	const row = parent.createDiv({ cls: `annoteca-stacked-row${opts.cls ? " " + opts.cls : ""}` });
	const labels = row.createDiv({ cls: "annoteca-stacked-labels" });
	labels.createDiv({ cls: "annoteca-stacked-name", text: opts.name });
	if (opts.description) {
		labels.createDiv({ cls: "annoteca-stacked-desc", text: opts.description });
	}
	const content = row.createDiv({ cls: "annoteca-stacked-content" });
	return { row, content };
}

// Obsidian's color palette as CSS variable names. These are theme-adaptive:
// the actual hex values shift with the user's accent palette and light/dark
// mode. Keeping them as var() strings is therefore preferable to baking in
// hex values for theme-friendly categories.
const THEME_COLOR_VARS = [
	"--color-red",
	"--color-orange",
	"--color-yellow",
	"--color-green",
	"--color-cyan",
	"--color-blue",
	"--color-purple",
	"--color-pink",
] as const;

export interface ColorPickerOpts {
	current: string | undefined;
	onChange: (next: string | undefined) => void | Promise<void>;
}

// Render a color picker control: row of theme swatches + native color picker
// + a Reset button. The active swatch is highlighted when current matches a
// var() form; otherwise the native picker reflects the current hex value.
export function createColorPicker(parent: HTMLElement, opts: ColorPickerOpts): HTMLDivElement {
	const wrap = parent.createDiv({ cls: "annoteca-color-picker" });

	const swatchRow = wrap.createDiv({ cls: "annoteca-color-swatches" });
	for (const v of THEME_COLOR_VARS) {
		const swatch = swatchRow.createEl("button", {
			cls: "annoteca-color-swatch",
			attr: { type: "button", "aria-label": `Set color to ${v.replace("--color-", "")}` },
		});
		// Set the background directly rather than going through a custom
		// property. Chained var() resolution inside an inline style works in
		// theory but was rendering empty in some Obsidian contexts; assigning
		// background-color directly is more reliable.
		swatch.style.backgroundColor = `var(${v})`;
		const target = `var(${v})`;
		if (opts.current === target) swatch.addClass("is-active");
		swatch.addEventListener("click", () => {
			void opts.onChange(target);
			// Update local active state without waiting for a re-render.
			for (const s of Array.from(swatchRow.children)) s.removeClass?.("is-active");
			swatch.addClass("is-active");
		});
	}

	const customWrap = wrap.createDiv({ cls: "annoteca-color-custom" });
	const native = customWrap.createEl("input", {
		cls: "annoteca-color-native",
		attr: { type: "color" },
	});
	// Pre-populate the native picker from a hex value if that is what we have;
	// otherwise leave the default (the browser usually shows black).
	const currentHex = opts.current && opts.current.startsWith("#") ? opts.current : "";
	if (currentHex) native.value = currentHex;
	native.addEventListener("input", () => {
		void opts.onChange(native.value);
		for (const s of Array.from(swatchRow.children)) s.removeClass?.("is-active");
	});

	const resetBtn = customWrap.createEl("button", {
		cls: "annoteca-color-reset",
		text: "Reset",
		attr: { type: "button" },
	});
	resetBtn.addEventListener("click", () => {
		void opts.onChange(undefined);
		for (const s of Array.from(swatchRow.children)) s.removeClass?.("is-active");
	});

	return wrap;
}

export interface IconPickerOpts {
	app: App;
	current: string | undefined;
	onChange: (next: string | undefined) => void | Promise<void>;
}

// Render an icon picker control: button showing the current icon (or a hint
// if none); clicking opens a modal with a searchable grid of every Obsidian
// icon. Selecting an icon updates the value and closes the modal.
export function createIconPicker(parent: HTMLElement, opts: IconPickerOpts): HTMLDivElement {
	const wrap = parent.createDiv({ cls: "annoteca-icon-picker" });

	const renderTrigger = (iconId: string | undefined): void => {
		wrap.empty();
		const trigger = wrap.createEl("button", {
			cls: "annoteca-icon-picker-trigger",
			attr: { type: "button" },
		});
		const preview = trigger.createSpan({ cls: "annoteca-icon-picker-preview" });
		if (iconId) {
			setIcon(preview, iconId);
		} else {
			preview.setText("?");
			preview.addClass("is-empty");
		}
		trigger.createSpan({
			cls: "annoteca-icon-picker-label",
			text: iconId ?? "Pick an icon",
		});
		trigger.addEventListener("click", () => {
			new IconPickerModal(opts.app, iconId, async next => {
				await opts.onChange(next);
				renderTrigger(next);
			}).open();
		});

		// Inline clear button so the user can reset to no icon.
		if (iconId) {
			const clear = wrap.createEl("button", {
				cls: "annoteca-icon-picker-clear",
				text: "Clear",
				attr: { type: "button" },
			});
			clear.addEventListener("click", () => {
				void opts.onChange(undefined);
				renderTrigger(undefined);
			});
		}
	};

	renderTrigger(opts.current);
	return wrap;
}

class IconPickerModal extends Modal {
	private readonly currentId: string | undefined;
	private readonly onPick: (next: string) => void | Promise<void>;
	private filterTerm = "";

	constructor(app: App, currentId: string | undefined, onPick: (next: string) => void | Promise<void>) {
		super(app);
		this.currentId = currentId;
		this.onPick = onPick;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("annoteca-icon-picker-modal");

		const header = contentEl.createDiv({ cls: "annoteca-icon-picker-header" });
		header.createEl("h3", { text: "Pick an icon" });

		const searchInput = header.createEl("input", {
			cls: "annoteca-icon-picker-search",
			attr: {
				type: "text",
				placeholder: "Search…",
			},
		});

		const grid = contentEl.createDiv({ cls: "annoteca-icon-picker-grid" });

		const renderGrid = (): void => {
			grid.empty();
			const allIds = getIconIds();
			const term = this.filterTerm.trim().toLowerCase();
			const matched = term === ""
				? allIds.slice(0, 200)
				: allIds.filter(id => id.toLowerCase().includes(term)).slice(0, 200);
			if (matched.length === 0) {
				grid.createDiv({ cls: "annoteca-icon-picker-empty", text: "No icons match." });
				return;
			}
			for (const id of matched) {
				const cell = grid.createEl("button", {
					cls: `annoteca-icon-picker-cell${id === this.currentId ? " is-active" : ""}`,
					attr: { type: "button", title: id, "aria-label": id },
				});
				const iconEl = cell.createSpan({ cls: "annoteca-icon-picker-cell-icon" });
				setIcon(iconEl, id);
				cell.createSpan({ cls: "annoteca-icon-picker-cell-label", text: id });
				cell.addEventListener("click", () => {
					void this.onPick(id);
					this.close();
				});
			}
		};

		searchInput.addEventListener("input", () => {
			this.filterTerm = searchInput.value;
			renderGrid();
		});

		renderGrid();
		window.setTimeout(() => searchInput.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
