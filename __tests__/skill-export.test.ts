import { buildSkillMarkdown, skillTargetPaths } from "../skill-export";
import { parseAll } from "../parser";
import type { CategoryDefinition } from "../types";

const CATEGORIES: CategoryDefinition[] = [
	{ id: "tone", displayName: "Tone" },
	{ id: "source-needed", displayName: "Source needed" },
];

describe("skillTargetPaths", () => {
	it("maps claude to the .claude skills path", () => {
		expect(skillTargetPaths("claude")).toEqual([".claude/skills/annoteca/SKILL.md"]);
	});

	it("maps agent to the .agent skills path", () => {
		expect(skillTargetPaths("agent")).toEqual([".agent/skills/annoteca/SKILL.md"]);
	});

	it("maps both to claude first, then agent", () => {
		expect(skillTargetPaths("both")).toEqual([
			".claude/skills/annoteca/SKILL.md",
			".agent/skills/annoteca/SKILL.md",
		]);
	});
});

describe("buildSkillMarkdown", () => {
	const skill = buildSkillMarkdown(CATEGORIES, undefined, "1.0.1");

	it("starts with frontmatter naming the skill", () => {
		expect(skill.startsWith("---\nname: annoteca-comments\n")).toBe(true);
		expect(skill).toContain("description: ");
	});

	it("embeds every configured category with its display name", () => {
		expect(skill).toContain("| `tone` | Tone |");
		expect(skill).toContain("| `source-needed` | Source needed |");
	});

	it("contains the canonical marker regex", () => {
		expect(skill).toContain("<!--\\s*annoteca/[a-z][a-z0-9-]*\\s*:[\\s\\S]*?-->");
	});

	it("ships an example marker that the real parser accepts", () => {
		// The multi-line example in the skill must stay parseable; if the format
		// or the example drifts, assistants get taught a broken grammar.
		const comments = parseAll(skill);
		const example = comments.find((c) => c.category === "tone");
		expect(example).toBeDefined();
		if (!example) return;
		expect(example.id).toBe("a3b9c2x7");
		expect(example.date).toBe("2026-05-23");
		expect(example.author).toBe("reviewer");
		expect(example.anchor?.text).toBe("She knew what love felt like.");
		expect(example.replies).toHaveLength(2);
		expect(example.resolution?.author).toBe("reviewer");
	});

	it("names the reviewer's author tag when one is configured", () => {
		const withTag = buildSkillMarkdown(CATEGORIES, "Charles", "1.0.1");
		expect(withTag).toContain("signs comments as `Charles`");
	});

	it("suggests a generic tag when no author tag is configured", () => {
		expect(skill).toContain("such as `claude` or `ai`");
	});

	it("stamps the generating plugin version and repo link", () => {
		expect(skill).toContain("version 1.0.1");
		expect(skill).toContain("https://github.com/ckelsoe/obsidian-annoteca");
	});
});
