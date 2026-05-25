// Per-category modal templates (F-212). When a structured category is
// selected, the modal renders these extra fields above the body. On submit,
// the field values are composed with the body into the final comment text.

export interface ModalField {
	id: string;
	label: string;
	placeholder?: string;
	type?: "text" | "textarea";
}

export interface ModalTemplate {
	fields: ModalField[];
	compose(values: Record<string, string>, body: string): string;
}

export const MODAL_TEMPLATES: Record<string, ModalTemplate> = {
	"verse-needed": {
		fields: [
			{ id: "book", label: "Book", placeholder: "John" },
			{ id: "chapter", label: "Chapter", placeholder: "3" },
			{ id: "verse", label: "Verse", placeholder: "16" },
			{ id: "translation", label: "Translation", placeholder: "ESV" },
		],
		compose(values, body) {
			const ref = composeScriptureReference(values);
			const parts: string[] = [];
			if (ref) parts.push(`cite ${ref}`);
			if (body) parts.push(body);
			return parts.join(" — ");
		},
	},
	"source-needed": {
		fields: [
			{ id: "citationFormat", label: "Citation format", placeholder: "APA" },
			{ id: "claim", label: "Claim needing source", placeholder: "what needs a source?", type: "textarea" },
		],
		compose(values, body) {
			const parts: string[] = [];
			const fmt = values["citationFormat"];
			if (fmt) parts.push(`Cite in ${fmt}`);
			const claim = values["claim"];
			if (claim) parts.push(claim);
			if (body) parts.push(body);
			return parts.join(": ");
		},
	},
	"index-entry": {
		fields: [
			{ id: "term", label: "Index term", placeholder: "Augustine, doctrine of grace" },
			{ id: "subterm", label: "Subterm (optional)", placeholder: "predestination" },
		],
		compose(values, body) {
			const term = values["term"];
			const subterm = values["subterm"];
			const parts: string[] = [];
			if (term) {
				parts.push(subterm ? `${term} > ${subterm}` : term);
			}
			if (body) parts.push(body);
			return parts.join(" — ");
		},
	},
};

export function composeScriptureReference(values: Record<string, string>): string {
	const book = values["book"]?.trim() ?? "";
	const chapter = values["chapter"]?.trim() ?? "";
	const verse = values["verse"]?.trim() ?? "";
	const translation = values["translation"]?.trim() ?? "";
	if (!book || !chapter || !verse) return "";
	const ref = `${book.charAt(0).toUpperCase() + book.slice(1)} ${chapter}:${verse}`;
	return translation ? `${ref} (${translation.toUpperCase()})` : ref;
}

export function getTemplate(categoryId: string): ModalTemplate | undefined {
	return MODAL_TEMPLATES[categoryId];
}
