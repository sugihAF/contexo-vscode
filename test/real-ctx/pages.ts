// Valid page text per type and slug, modelled on Contexo internal/testkit PageBytes
// (schema.SerializePage output: yaml.v3 key order, '# <title>' body), so a written page is
// already in Normalize form.
export type PageType = "concept" | "entity" | "analysis" | "source";

const DIRS: Record<PageType, string> = {
  concept: "wiki/concepts",
  entity: "wiki/entities",
  analysis: "wiki/analyses",
  source: "raw/sessions",
};

/** The contract RelPath of a page: <type dir>/<slug>.md. */
export function relPathOf(type: PageType, slug: string): string {
  return `${DIRS[type]}/${slug}.md`;
}

export interface PageSpec {
  type: PageType;
  slug: string;
  title?: string;
  body?: string;
  author?: string;
  tags?: string[];
}

/** The page text: frontmatter then '# <title>' and the optional body. */
export function pageText(spec: PageSpec): string {
  const title = spec.title ?? spec.slug;
  const lines = [
    "---",
    "schema: ctx.page.v1",
    `slug: ${spec.slug}`,
    `type: ${spec.type}`,
    `author: ${spec.author ?? "alice"}`,
    "created: 2026-10-01T00:00:00Z",
    "updated: 2026-10-01T00:00:00Z",
    "parent_sha: \"\"",
  ];
  if (spec.tags && spec.tags.length > 0) {
    lines.push("tags:", ...spec.tags.map((t) => `  - ${t}`));
  }
  lines.push("---", `# ${title}`);
  let text = `${lines.join("\n")}\n`;
  if (spec.body) { text += `\n${spec.body}${spec.body.endsWith("\n") ? "" : "\n"}`; }
  return text;
}

/** A page whose frontmatter does not parse (an 'invalid' page, stage parse). */
export function brokenPageText(slug: string): string {
  return `---\nschema: ctx.page.v1\nslug: ${slug}\ntype: [unclosed\n---\n# Broken\n`;
}
