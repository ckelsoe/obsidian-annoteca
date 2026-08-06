// Builds the SKILL.md that teaches an AI assistant the Annoteca marker format.
// No Obsidian dependency; main.ts performs the vault writes. The grammar
// described here mirrors parser.ts, which is the source of truth. The longer
// narrative contract lives in the (private) data-format spec; this file is the
// distilled, assistant-facing version that ships into a user's vault.

import type { CategoryDefinition } from './types';

export type SkillExportTarget = 'claude' | 'agent' | 'both';

// Schema version of the exported skill's teaching. Bumped only when the
// assistant-facing guidance materially changes, so users are prompted to
// re-export when the content is genuinely different rather than on every plugin
// release. 1 = the original skill; 2 = the AI-revision-flow skill
// (begin-placement, addressed flow, forbid marker deletion / unprompted resolve);
// 3 = full-timestamp stamps (YYYY-MM-DDTHH:MM:SS) so AI-written lines sort in
// read order alongside the plugin's own timestamped writes (F-280).
// Bumped to 4 when the `-->` escape was documented. An assistant working from a
// v3 skill does not know to escape it and will corrupt a note the moment it
// writes a body containing one, so existing exports have to be flagged stale.
// 5 = the author token grammar and what breaking it costs. Through v4 the skill
// gave the shape of a token but never said that a violating author makes the
// whole line unmatchable, so an assistant signing as `Bob Smith` silently lost
// the comment's author, or, in a trailing line, the entire thread. Same reason
// as the bump above: an assistant reading a v4 skill does not know.
export const SKILL_SCHEMA_VERSION = 5;

const SKILL_VERSION_RE = /^annoteca-skill-version:\s*(\d+)\s*$/m;

// Read the schema version stamped into an exported skill. Returns 0 when the
// stamp is absent (a skill exported before versioning), which is always treated
// as older than the current version.
export function parseSkillVersion(content: string): number {
	const m = SKILL_VERSION_RE.exec(content);
	const raw = m?.[1];
	return raw !== undefined ? Number.parseInt(raw, 10) : 0;
}

export type SkillStatus = 'missing' | 'stale' | 'current';

// Status of an exported skill given its on-disk content (null = the file does
// not exist). Pure so it is unit-testable without the vault adapter.
export function skillStatus(content: string | null): SkillStatus {
	if (content === null) return 'missing';
	return parseSkillVersion(content) < SKILL_SCHEMA_VERSION
		? 'stale'
		: 'current';
}

// Vault-relative destinations. Dot-folders are hidden from the vault file
// index, so callers must write through the DataAdapter, not the Vault API.
const SKILL_FILE_BY_TARGET: Record<'claude' | 'agent', string> = {
	claude: '.claude/skills/annoteca/SKILL.md',
	agent: '.agent/skills/annoteca/SKILL.md',
};

export function skillTargetPaths(target: SkillExportTarget): string[] {
	if (target === 'both') {
		return [SKILL_FILE_BY_TARGET.claude, SKILL_FILE_BY_TARGET.agent];
	}
	return [SKILL_FILE_BY_TARGET[target]];
}

function categoryTable(categories: CategoryDefinition[]): string {
	// Single backticks are safe here: a category id is `[a-z][a-z0-9-]*`, so
	// it cannot hold a backtick. The reviewer tag can, hence inlineCode below.
	const rows = categories.map((c) => `| \`${c.id}\` | ${c.displayName} |`);
	return ['| Category | Meaning |', '| --- | --- |', ...rows].join('\n');
}

// A code span whose delimiter is longer than any backtick run inside the text,
// space-padded when the text starts or ends with a backtick (CommonMark strips
// that padding back out). The author token grammar allows backticks, so a
// literal single-backtick wrap around the tag ends the span at the tag's own
// backtick and the exported markdown breaks. Same rule the annoteca-original
// fence follows: measure the content, exceed it.
function inlineCode(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) {
		if (run.length > longest) longest = run.length;
	}
	const delimiter = '`'.repeat(longest + 1);
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return `${delimiter}${pad}${text}${pad}${delimiter}`;
}

export function buildSkillMarkdown(
	categories: CategoryDefinition[],
	authorTag: string | undefined,
): string {
	// Read, not repaired. `normalizeSettings` is the single ingress for
	// data.json and already runs the tag through the token grammar, so the
	// trim this used to do was a second, weaker copy of that rule living
	// outside the choke point. Empty still means "no tag set".
	const reviewer =
		authorTag !== undefined && authorTag !== '' ? authorTag : undefined;
	const reviewerLine = reviewer
		? `The human reviewer in this vault signs comments as ${inlineCode(reviewer)}. Pick a different tag for yourself (for example \`claude\` or \`ai\`).`
		: `Sign your lines with a short tag such as \`claude\` or \`ai\`.`;

	return `---
name: annoteca-comments
description: Read, reply to, create, and resolve Annoteca feedback comments stored as HTML markers in markdown files. Use when asked to review a note, address comments, reply to feedback, or annotate a document in a vault that contains Annoteca markers.
annoteca-skill-version: ${SKILL_SCHEMA_VERSION}
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
[date=2026-05-23T09:12:00]
[author=reviewer]
[anchor=assumes a hiring freeze through December]
[reply ai 2026-05-23T09:15:30]: Consider "reflects current headcount planning through December."
[reply reviewer 2026-05-24T08:40:00]: Better. Softening it.
[resolved reviewer 2026-05-25T16:20:00]: reworded the assumption
-->
\`\`\`

Structured lines sit at the END of the comment, after all body text, one per line, in this order: \`[id=]\`, \`[date=]\`, \`[author=]\`, \`[anchor=]\`, then \`[reply ...]\` lines oldest first, then at most one \`[addressed ...]\` line (with its optional \`annoteca-original\` fence), then at most one \`[resolved ...]\` line.

Field rules (match these exactly; the plugin's parser enforces them):

- Category: lowercase letters, digits, single dashes; starts with a letter; never \`reply\`, \`resolved\`, \`id\`, \`date\`, or \`author\`.
- Author: exactly one token matching \`[^\\s\\]<>]{1,32}\`, so 1 to 32 characters with no whitespace and none of \`]\` \`<\` \`>\`. Write a display name as a single token by joining the words with dashes (\`Bob Smith\` becomes \`Bob-Smith\`); do not quote it or add brackets. **An author that breaks this grammar makes the whole line unmatchable, and the cost is not one field.** A space or a \`<\` in \`[author=...]\` drops that line, and the comment loses its author on the next rewrite. A \`]\` is worse, because it ends the bracket early: the line is then not a structured line of any shape, so the walk stops on it and that line, the \`[id=]\`, the \`[date=]\` and everything else collapse into the body as visible text. In a \`[reply ...]\`, \`[addressed ...]\` or \`[resolved ...]\` line ANY of them does that, exactly like the line break described below, and the thread and the comment's identity go with it. ${reviewerLine}
- Date/timestamp: \`YYYY-MM-DDTHH:MM:SS\` (the current local date and time; seconds optional). **Always stamp the current time, not a date alone.** The panel sorts a thread by these stamps on read, and a date-only stamp sorts to the very start of its day, so a date-only reply jumps ahead of every timestamped reply made earlier the same day. Date-only stamps still parse (older markers), but new lines you write must carry the time so a fast human/AI back-and-forth stays in order.
- id: 8 lowercase base36 chars (\`a3b9c2x7\`), unique in the vault. Generate one for comments you create.
- Anchor: single line, max 80 chars, no \`]\` or newlines. Quote of the text the comment refers to. Optional.
- Reply: \`[reply <author> <timestamp>]: <inline markdown>\`.
- Addressed: \`[addressed <author> <timestamp>]: <note>\`, at most one, after the replies and before any \`[resolved ...]\` line. It means "I applied an edit; the reviewer still needs to accept, revise, or reject." When the edit *replaced* prose, store the verbatim old text in a fenced \`annoteca-original\` block on the lines directly after the \`[addressed ...]\` line so the reviewer can reject and auto-revert.
- Resolved: \`[resolved <author> <timestamp>]: <optional note>\`.
- **No line breaks in a trailing line**: \`[anchor=]\`, \`[reply ...]\`, \`[addressed ...]\` and \`[resolved ...]\` are each exactly ONE line, and the parser matches them line by line. A line break inside any of them produces a continuation line that matches nothing, which ends the structured section there: that line, the \`[id=]\`, and every other trailing line collapse into the body as visible text, and the thread is lost along with the comment's identity. So write a reply or a note as a single line, however long. If you want list-like structure, use separators inline (\`first point; second point\`) rather than a newline. The two places multi-line text IS safe are the comment body and the \`annoteca-original\` fence, because neither is parsed line by line.
- **The \`annoteca-original\` fence must outlast its content**: the block holds verbatim prose lifted from the document, which can itself contain a fenced code block, and the first line that is just the fence delimiter closes it. Ending it early loses the original, the \`[addressed ...]\` line, and the comment's id. So count the longest run of backticks that starts a line inside the text you are storing and open and close with a run at least one longer: plain prose gets the usual three, text containing a \`\`\` block gets four, and so on. Do not escape the backticks; the whole point of the block is that the text comes back byte for byte.
- **Escaping \`-->\`**: the marker is an HTML comment, so a literal \`-->\` anywhere inside one would end it early, truncating the comment and spilling the rest into the document as visible text. Write it as \`--\\>\` instead, in every free-text field: the body, \`[anchor=]\`, reply bodies, the \`[addressed ...]\` and \`[resolved ...]\` notes, and inside the \`annoteca-original\` fence. The plugin displays \`--\\>\` as \`-->\`. If the text you are storing already contains \`--\\>\`, add one more backslash (\`--\\\\>\`); the rule is that reading removes one backslash from the run, so writing adds one.

## What to do

- **Reply to a comment**: append a \`[reply <you> <now>]: ...\` line as the last line before \`-->\` (after existing replies, before any \`[addressed ...]\` or \`[resolved ...]\` line), where \`<now>\` is the current \`YYYY-MM-DDTHH:MM:SS\` timestamp. Never rewrite the original body or others' replies.
- **Address a comment with a small in-place tweak**: edit the passage the comment points at (use the \`[anchor=]\` quote to locate it), then reply in the thread saying what you changed and why. Leave the rest of the document byte-for-byte untouched.
- **Address a comment by replacing the passage**: this is the lossless flow. (1) Replace the anchored passage with your new text. (2) Leave the marker at the **head** of the new text (markers lead the text they concern). (3) Inside the marker, add an \`[addressed <you> <now>]: <what you changed and why>\` line (\`<now>\` = the current timestamp); on the line directly after it open a fenced block tagged \`annoteca-original\`, put the verbatim text you replaced on its own line(s), then close the fence. Keep the original \`[anchor=]\` line as-is; it is the historical record of what was commented on. Do not mark the comment resolved; the reviewer decides accept / revise / reject. See the worked example below.
- **Create a comment**: insert a marker at the **start** of the passage it concerns (the prose it is about follows the marker), with your category choice, an id, the current \`YYYY-MM-DDTHH:MM:SS\` timestamp, and your author tag.
- **Resolve a comment**: ONLY when the user explicitly asks. Append one \`[resolved <you> <now>]: <note>\` line (\`<now>\` = the current timestamp). **Never resolve a comment unprompted** (rationale: resolution is the reviewer's decision; resolving feedback the reviewer has not signed off on destroys the review loop this format exists to protect).
- **Never delete a marker.** Do not remove a marker to "clean up", and never resolve by rewriting the file so the markers disappear (rationale: the markers are the audit trail; deleting them silently discards the conversation and the reviewer's pending decisions). Removal happens only when the user explicitly asks to delete a specific comment.

### Addressing by replacement: worked example

After replacing the passage, the marker leads the new prose and the verbatim old text lives in the fence. The \`annoteca-original\` fence open and close lines start at the left margin inside the comment (not indented), or the plugin will not recognize them:

\`\`\`\`markdown
<!-- annoteca/clarify: hedging
[id=6raa4103]
[date=2026-06-20T11:30:00]
[anchor=it landed as a shock]
[addressed claude 2026-06-20T11:32:10]: removed the hedging
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
