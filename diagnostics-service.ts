// Diagnostics service. Owns the vault-scanning diagnostics commands and the
// report note they write. Extracted from AnnotecaPlugin so the plugin class
// stays focused on lifecycle and command wiring, and so the three marker
// scans share one parameterized loop instead of three copies.

import { Notice, TFile } from "obsidian";

import type AnnotecaPlugin from "./main";
import {
	detectMarkerConflicts,
	detectOrphans,
	validateMarkers,
} from "./diagnostics";
import { detectDrift, type DriftFinding, type PositionSnapshot } from "./drift";
import { todayISO } from "./parser";

export class DiagnosticsService {
	constructor(private readonly plugin: AnnotecaPlugin) {}

	// The three marker scans share one shape: walk every markdown file, run
	// a detector over its content, and either notice "all clear" or write a
	// report note plus a count notice. Each check supplies its detector and
	// user-facing copy. `scanIndexFirst` matches the original behavior:
	// conflict and orphan detection consult the comment index, marker
	// validation reads raw content only.
	private async runDetectorScan(options: {
		readonly label: string;
		readonly emptyMessage: string;
		readonly foundMessage: (count: number) => string;
		readonly detect: (content: string, path: string) => readonly unknown[];
		readonly scanIndexFirst: boolean;
	}): Promise<void> {
		if (options.scanIndexFirst) {
			await this.plugin.scanVaultIfNeeded();
		}
		const findings: unknown[] = [];
		const files = this.plugin.app.vault.getMarkdownFiles();
		for (const f of files) {
			const content = await this.plugin.app.vault.cachedRead(f);
			findings.push(...options.detect(content, f.path));
		}
		if (findings.length === 0) {
			new Notice(options.emptyMessage);
			return;
		}
		await this.writeReport(options.label, findings);
		new Notice(options.foundMessage(findings.length));
	}

	async runConflictCheck(): Promise<void> {
		await this.runDetectorScan({
			label: "Marker conflicts",
			emptyMessage: "No marker conflicts detected.",
			foundMessage: (n) => `Found ${n} potential conflict(s). See the diagnostics note in the vault.`,
			detect: detectMarkerConflicts,
			scanIndexFirst: true,
		});
	}

	async runOrphanCheck(): Promise<void> {
		await this.runDetectorScan({
			label: "Orphan comments",
			emptyMessage: "No orphan comments detected.",
			foundMessage: (n) => `Found ${n} orphan(s). See the diagnostics note in the vault.`,
			detect: detectOrphans,
			scanIndexFirst: true,
		});
	}

	async runMarkerValidation(): Promise<void> {
		await this.runDetectorScan({
			label: "Malformed markers",
			emptyMessage: "All markers are valid.",
			foundMessage: (n) => `Found ${n} malformed marker(s). See the diagnostics note in the vault.`,
			detect: validateMarkers,
			scanIndexFirst: false,
		});
	}

	async runSelfDiagnostic(): Promise<void> {
		await this.plugin.scanVaultIfNeeded();
		const stats = this.plugin.commentIndex.stats();
		const enabled = this.plugin.settings.categories.length;
		const summary = {
			fileCount: stats.fileCount,
			commentCount: stats.commentCount,
			unresolvedCount: stats.unresolvedCount,
			enabledCategories: enabled,
			scholarlyPreset: this.plugin.settings.enableScholarlyPreset,
			indicatorStyle: this.plugin.settings.indicatorStyle,
			authorTagEnabled: this.plugin.settings.enableAuthorTag,
			debugMode: this.plugin.settings.debugMode,
		};
		await this.writeReport("Self-diagnostic", [summary]);
		new Notice(`Plugin healthy. ${stats.commentCount} comment(s) indexed across ${stats.fileCount} file(s).`);
	}

	async runDriftCheck(): Promise<void> {
		await this.plugin.scanVaultIfNeeded();
		const prior: Record<string, PositionSnapshot> = this.plugin.settings.driftSnapshots ?? {};
		const allFindings: DriftFinding[] = [];
		let refreshed: Record<string, PositionSnapshot> = { ...prior };
		const files = this.plugin.app.vault.getMarkdownFiles();
		const liveIds = new Set<string>();
		for (const f of files) {
			const content = await this.plugin.app.vault.cachedRead(f);
			const idx = this.plugin.commentIndex.get(f.path);
			const comments = idx?.comments ?? [];
			for (const c of comments) if (c.id) liveIds.add(c.id);
			const r = detectDrift(content, f.path, comments, refreshed);
			refreshed = r.refreshedSnapshots;
			allFindings.push(...r.findings);
		}
		for (const id of Object.keys(refreshed)) {
			if (!liveIds.has(id)) delete refreshed[id];
		}
		this.plugin.settings.driftSnapshots = refreshed;
		await this.plugin.saveSettings();

		if (allFindings.length === 0) {
			new Notice("No position drift detected. Snapshots refreshed.");
			return;
		}
		await this.writeReport("Position drift", allFindings);
		new Notice(`Found ${allFindings.length} drift finding(s). See the diagnostics note in the vault.`);
	}

	private async writeReport(label: string, findings: unknown[]): Promise<void> {
		// Write findings to a vault note so the user can read them without
		// opening devtools. V2 adds debug-log routing per F-237.
		const filename = `Annoteca diagnostics — ${label}.md`;
		const lines: string[] = [];
		lines.push(`# ${label}`);
		lines.push("");
		lines.push(`Generated: ${todayISO()}`);
		lines.push("");
		lines.push("```json");
		lines.push(JSON.stringify(findings, null, 2));
		lines.push("```");
		const body = lines.join("\n");

		const existing = this.plugin.app.vault.getAbstractFileByPath(filename);
		if (existing instanceof TFile) {
			await this.plugin.app.vault.modify(existing, body);
		} else {
			await this.plugin.app.vault.create(filename, body);
		}
	}
}
