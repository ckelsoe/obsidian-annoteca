// In-memory per-file comment index. No Obsidian dependency in the pure surface.
// Owners call rebuild(path, content) on file events; queries are read-only.

import type { Comment, LocatedComment } from "./types";
import { parseAll } from "./parser";

export interface FileIndex {
	path: string;
	comments: Comment[];
	parsedAt: number;
}

export interface VaultFilter {
	paths?: ReadonlySet<string>;
	categories?: ReadonlySet<string>;
	resolved?: "open" | "resolved" | "all";
	author?: string;
}

export class CommentIndex {
	private readonly files = new Map<string, FileIndex>();

	get(path: string): FileIndex | undefined {
		return this.files.get(path);
	}

	all(): IterableIterator<FileIndex> {
		return this.files.values();
	}

	rebuild(path: string, content: string): FileIndex {
		const idx: FileIndex = {
			path,
			comments: parseAll(content),
			parsedAt: Date.now(),
		};
		this.files.set(path, idx);
		return idx;
	}

	remove(path: string): void {
		this.files.delete(path);
	}

	rename(oldPath: string, newPath: string): void {
		const prev = this.files.get(oldPath);
		if (!prev) return;
		this.files.delete(oldPath);
		this.files.set(newPath, { ...prev, path: newPath });
	}

	clear(): void {
		this.files.clear();
	}

	queryByCategory(path: string, category: string): Comment[] {
		const idx = this.files.get(path);
		if (!idx) return [];
		return idx.comments.filter(c => c.category === category);
	}

	queryUnresolved(filter?: VaultFilter): LocatedComment[] {
		const out: LocatedComment[] = [];
		for (const idx of this.files.values()) {
			if (filter?.paths && !filter.paths.has(idx.path)) continue;
			for (const c of idx.comments) {
				if (filter?.categories && !filter.categories.has(c.category)) continue;
				if (filter?.author && c.author !== filter.author) continue;
				const isResolved = c.resolution !== undefined;
				const wanted = filter?.resolved ?? "open";
				if (wanted === "open" && isResolved) continue;
				if (wanted === "resolved" && !isResolved) continue;
				out.push({ path: idx.path, comment: c });
			}
		}
		return out;
	}

	queryAll(filter?: VaultFilter): LocatedComment[] {
		const base = { ...filter, resolved: filter?.resolved ?? "all" };
		return this.queryUnresolved(base);
	}

	hasId(id: string): boolean {
		for (const idx of this.files.values()) {
			for (const c of idx.comments) {
				if (c.id === id) return true;
			}
		}
		return false;
	}

	stats(): { fileCount: number; commentCount: number; unresolvedCount: number } {
		let commentCount = 0;
		let unresolvedCount = 0;
		for (const idx of this.files.values()) {
			commentCount += idx.comments.length;
			for (const c of idx.comments) {
				if (!c.resolution) unresolvedCount++;
			}
		}
		return { fileCount: this.files.size, commentCount, unresolvedCount };
	}
}
