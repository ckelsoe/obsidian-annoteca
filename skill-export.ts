// Builds the SKILL.md that teaches an AI assistant the Annoteca marker format.
// No Obsidian dependency; main.ts performs the vault writes. The grammar
// described here mirrors parser.ts, which is the source of truth. The longer
// narrative contract lives in the (private) data-format spec; this file is the
// distilled, assistant-facing version that ships into a user's vault.

import type { CategoryDefinition } from "./types";

export type SkillExportTarget = "claude" | "agent" | "both";

// Vault-relative destinations. Dot-folders are hidden from the vault file
// index, so callers must write through the DataAdapter, not the Vault API.
const SKILL_FILE_BY_TARGET: Record<"claude" | "agent", string> = {
	claude: ".claude/skills/annoteca/SKILL.md",
	agent: ".agent/skills/annoteca/SKILL.md",
};

export function skillTargetPaths(target: SkillExportTarget): string[] {
	if (target === "both") {
		return [SKILL_FILE_BY_TARGET.claude, SKILL_FILE_BY_TARGET.agent];
	}
	return [SKILL_FILE_BY_TARGET[target]];
}

function categoryTable(categories: CategoryDefinition[]): string {
	const rows = categories.map((c) => `| \`${c.id}\` | ${c.displayName} |`);
	return ["| Category | Meaning |", "| --- | --- |", ...rows].join("\n");
}

export function buildSkillMarkdown(
	categories: CategoryDefinition[],
	authorTag: string | undefined,
): string {
	const reviewer = authorTag && authorTag.trim() !== "" ? authorTag.trim() : undefined;
	const reviewerLine = reviewer
		? `The human reviewer in this vault signs comments as \`${reviewer}\`. Pick a different tag for yourself (for example \`claude\` or \`ai\`).`
		: `Sign your lines with a short tag such as \`claude\` or \`ai\`.`;

	return `---
name: annoteca-comments
description: Read, reply to, create, and resolve Annoteca feedback comments stored as HTML markers in markdown files. Use when asked to review a note, address comments, reply to feedback, or annotate a document in a vault that contains Annoteca markers.
---

# Annoteca comment markers

Annoteca stores feedback comments inline in markdown files as HTML comments. The file is the API: read and edit the file directly; no plugin API, MCP server, or other tooling is needed. The plugin re-parses on file change and surfaces your edits to the reviewer.

Find every marker with this stable regex:

\`\`\`
<!--\\s*annoteca/[a-z][a-z0-9-]*\\s*:[\\s\\S]*?-->
\`\`\`

## Marker grammar

Single-line comment:

\`\`\`markdown
Some prose being reviewed. <!-- annoteca/clarify: which products? -->
\`\`\`

Multi-line comment with metadata, a thread, and a resolution:

\`\`\`markdown
The Q3 forecast assumes a hiring freeze through December.
<!-- annoteca/tone: too blunt for the board deck
[id=a3b9c2x7]
[date=2026-05-23]
[author=reviewer]
[anchor=assumes a hiring freeze through December]
[reply ai 2026-05-23]: Consider "reflects current headcount planning through December."
[reply reviewer 2026-05-24]: Better. Softening it.
[resolved reviewer 2026-05-25]: reworded the assumption
-->
\`\`\`

Structured lines sit at the END of the comment, after all body text, one per line, in this order: \`[id=]\`, \`[date=]\`, \`[author=]\`, \`[anchor=]\`, then \`[reply ...]\` lines oldest first, then at most one \`[addressed ...]\` line (with its optional \`annoteca-original\` fence), then at most one \`[resolved ...]\` line.

Field rules (match these exactly; the plugin's parser enforces them):

- Category: lowercase letters, digits, single dashes; starts with a letter; never \`reply\`, \`resolved\`, \`id\`, \`date\`, or \`author\`.
- Author: one token, max 32 chars, no spaces and none of \`]\` \`<\` \`>\`. ${reviewerLine}
- Date: \`YYYY-MM-DD\`.
- id: 8 lowercase base36 chars (\`a3b9c2x7\`), unique in the vault. Generate one for comments you create.
- Anchor: single line, max 80 chars, no \`]\` or newlines. Quote of the text the comment refers to. Optional.
- Reply: \`[reply <author> <date>]: <inline markdown>\`.
- Addressed: \`[addressed <author> <date>]: <note>\`, at most one, after the replies and before any \`[resolved ...]\` line. It means "I applied an edit; the reviewer still needs to accept, revise, or reject." When the edit *replaced* prose, store the verbatim old text in a fenced \`annoteca-original\` block on the lines directly after the \`[addressed ...]\` line so the reviewer can reject and auto-revert.
- Resolved: \`[resolved <author> <date>]: <optional note>\`.

## What to do

- **Reply to a comment**: append a \`[reply <you> <today>]: ...\` line as the last line before \`-->\` (after existing replies, before any \`[addressed ...]\` or \`[resolved ...]\` line). Never rewrite the original body or others' replies.
- **Address a comment with a small in-place tweak**: edit the passage the comment points at (use the \`[anchor=]\` quote to locate it), then reply in the thread saying what you changed and why. Leave the rest of the document byte-for-byte untouched.
- **Address a comment by replacing the passage**: this is the lossless flow. (1) Replace the anchored passage with your new text. (2) Leave the marker at the **head** of the new text (markers lead the text they concern). (3) Inside the marker, add an \`[addressed <you> <today>]: <what you changed and why>\` line; on the line directly after it open a fenced block tagged \`annoteca-original\`, put the verbatim text you replaced on its own line(s), then close the fence. Keep the original \`[anchor=]\` line as-is; it is the historical record of what was commented on. Do not mark the comment resolved; the reviewer decides accept / revise / reject. See the worked example below.
- **Create a comment**: insert a marker at the **start** of the passage it concerns (the prose it is about follows the marker), with your category choice, an id, today's date, and your author tag.
- **Resolve a comment**: ONLY when the user explicitly asks. Append one \`[resolved <you> <today>]: <note>\` line. **Never resolve a comment unprompted** (rationale: resolution is the reviewer's decision; resolving feedback the reviewer has not signed off on destroys the review loop this format exists to protect).
- **Never delete a marker.** Do not remove a marker to "clean up", and never resolve by rewriting the file so the markers disappear (rationale: the markers are the audit trail; deleting them silently discards the conversation and the reviewer's pending decisions). Removal happens only when the user explicitly asks to delete a specific comment.

### Addressing by replacement: worked example

After replacing the passage, the marker leads the new prose and the verbatim old text lives in the fence. The \`annoteca-original\` fence open and close lines start at the left margin inside the comment (not indented), or the plugin will not recognize them:

\`\`\`\`markdown
<!-- annoteca/clarify: hedging
[id=6raa4103]
[date=2026-06-20]
[anchor=it landed as a shock]
[addressed claude 2026-06-20]: removed the hedging
\`\`\`annoteca-original
It landed as a shock.
\`\`\`
--> The discovery reframed the passage entirely.
\`\`\`\`

## Categories in this vault

Treat the category as a typed hint about the kind of feedback.

${categoryTable(categories)}
`;
}
