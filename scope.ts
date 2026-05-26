// Pure scope-dispatch logic: given a flattened view of vault files and a
// scope shape, return the set of paths that fall inside that scope. No
// Obsidian dependency — main.ts adapts the live workspace into ScopeFile
// records, then delegates here. Kept pure so the dispatch is unit-testable.

import type { ScopeShape } from "./types";

export interface ScopeFile {
	path: string;
	parentPath: string | undefined;
	isInRoot: boolean;
	frontmatter: Record<string, unknown> | undefined;
	tags: string[];
}

export function computeScopeFileSet(
	files: ScopeFile[],
	shape: ScopeShape,
	anchorPath: string | undefined,
): Set<string> {
	const out = new Set<string>();

	switch (shape.kind) {
		case "file": {
			if (anchorPath !== undefined && anchorPath !== "") out.add(anchorPath);
			return out;
		}
		case "folder": {
			const folder = anchorPath ?? "";
			const subfolders = shape.subfolders;
			for (const f of files) {
				if (subfolders) {
					if (folder === "" || f.path.startsWith(folder + "/") || f.parentPath === folder) {
						out.add(f.path);
					}
				} else {
					if ((folder === "" && f.isInRoot) || f.parentPath === folder) {
						out.add(f.path);
					}
				}
			}
			return out;
		}
		case "vault": {
			for (const f of files) out.add(f.path);
			return out;
		}
		case "property": {
			const { key, value } = shape;
			for (const f of files) {
				if (!f.frontmatter) continue;
				const v: unknown = f.frontmatter[key];
				if (Array.isArray(v) ? v.includes(value) : v === value) out.add(f.path);
			}
			return out;
		}
		case "tag": {
			const target = shape.tag.startsWith("#") ? shape.tag : "#" + shape.tag;
			for (const f of files) {
				if (f.tags.includes(target)) out.add(f.path);
			}
			return out;
		}
	}
}
