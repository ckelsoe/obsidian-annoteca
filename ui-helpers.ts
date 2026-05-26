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

// Convert "rgb(R, G, B)" or "rgba(R, G, B, A)" (whatever the browser
// normalizes a CSS variable to) to a 6-digit hex string the native
// <input type="color"> accepts.
function rgbStringToHex(rgb: string): string {
	const m = rgb.match(/\d+(?:\.\d+)?/g);
	if (!m || m.length < 3) return "#000000";
	const [r, g, b] = m;
	const toHex = (raw: string | undefined): string => {
		const n = Math.max(0, Math.min(255, Math.round(parseFloat(raw ?? "0"))));
		return n.toString(16).padStart(2, "0");
	};
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Render a color picker control: theme swatches above, a custom-color chip
// (styled native picker) + Reset below. Section captions disambiguate
// "these are theme-adaptive colors" from "pick a literal hex". The custom
// chip's underlying <input type="color"> is kept seeded with the currently
// active theme color (resolved to hex via getComputedStyle) so opening the
// OS picker opens it on the theme color, ready to nudge into a variation.
export function createColorPicker(parent: HTMLElement, opts: ColorPickerOpts): HTMLDivElement {
	const wrap = parent.createDiv({ cls: "annoteca-color-picker" });

	const themeRow = wrap.createDiv({ cls: "annoteca-color-row" });
	themeRow.createDiv({ cls: "annoteca-color-row-caption", text: "Theme" });
	const swatchRow = themeRow.createDiv({ cls: "annoteca-color-swatches" });

	const customRow = wrap.createDiv({ cls: "annoteca-color-row" });
	customRow.createDiv({ cls: "annoteca-color-row-caption", text: "Custom" });
	const customGroup = customRow.createDiv({ cls: "annoteca-color-custom" });
	const chip = customGroup.createDiv({
		cls: "annoteca-color-custom-chip",
		attr: { "aria-label": "Pick a custom color" },
	});
	const native = chip.createEl("input", {
		cls: "annoteca-color-native",
		attr: { type: "color", "aria-label": "Pick a custom color" },
	});

	const showHex = (hex: string): void => {
		native.value = hex;
		chip.style.backgroundColor = hex;
		chip.addClass("has-value");
	};
	const clearChip = (): void => {
		chip.style.removeProperty("background-color");
		chip.removeClass("has-value");
	};
	const clearSwatches = (): void => {
		for (const s of Array.from(swatchRow.children)) s.removeClass?.("is-active");
	};

	// Update the native input's value (silently — does not fire 'input')
	// so the OS color picker opens on this color when the chip is clicked.
	// Used to seed from the active theme swatch for "nudge into a variation".
	const seedFromSwatch = (swatch: HTMLElement): void => {
		const computed = getComputedStyle(swatch).backgroundColor;
		const hex = rgbStringToHex(computed);
		native.value = hex;
	};

	let activeSwatch: HTMLElement | null = null;

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
		if (opts.current === target) {
			swatch.addClass("is-active");
			activeSwatch = swatch;
		}
		swatch.addEventListener("click", () => {
			void opts.onChange(target);
			clearSwatches();
			swatch.addClass("is-active");
			clearChip();
			seedFromSwatch(swatch);
		});
	}

	// Pre-populate the chip when current is a custom hex value.
	const currentHex = opts.current && opts.current.startsWith("#") ? opts.current : "";
	if (currentHex) {
		showHex(currentHex);
	} else if (activeSwatch) {
		// Seed the native picker from the currently active theme swatch.
		// Deferred so the swatch is attached to the DOM before we ask the
		// browser for its computed background-color.
		const swatch = activeSwatch;
		window.requestAnimationFrame(() => seedFromSwatch(swatch));
	}

	native.addEventListener("input", () => {
		void opts.onChange(native.value);
		showHex(native.value);
		clearSwatches();
	});

	const resetBtn = customGroup.createEl("button", {
		cls: "annoteca-color-reset",
		text: "Reset",
		attr: { type: "button" },
	});
	resetBtn.addEventListener("click", () => {
		void opts.onChange(undefined);
		clearChip();
		clearSwatches();
	});

	return wrap;
}

export interface IconPickerOpts {
	app: App;
	current: string | undefined;
	onChange: (next: string | undefined) => void | Promise<void>;
}

// Render an icon picker control: a square button showing just the current
// icon (no ID text — the icon ID is implementation detail, not a label).
// Clicking opens a modal with a searchable grid. The icon ID is exposed via
// the trigger's tooltip and aria-label for hover/a11y.
export function createIconPicker(parent: HTMLElement, opts: IconPickerOpts): HTMLDivElement {
	const wrap = parent.createDiv({ cls: "annoteca-icon-picker" });

	const renderTrigger = (iconId: string | undefined): void => {
		wrap.empty();
		const tooltip = iconId ? `Icon: ${iconId}` : "Pick an icon";
		const trigger = wrap.createEl("button", {
			cls: "annoteca-icon-picker-trigger",
			attr: { type: "button", title: tooltip, "aria-label": tooltip },
		});
		const preview = trigger.createSpan({ cls: "annoteca-icon-picker-preview" });
		if (iconId) {
			setIcon(preview, iconId);
		} else {
			preview.setText("?");
			preview.addClass("is-empty");
		}
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
