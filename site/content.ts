// The landing page reads README.md at build time. The headings it names are a build contract: renaming one fails the build with a message that says so.

/** The lines after the exact `#`×level heading line, up to the next heading of the same or a higher level. */
export function readmeSection(markdown: string, heading: string, level: 2 | 3): string {
  const hashes = "#".repeat(level);
  const lines = markdown.split("\n");
  const start = lines.indexOf(`${hashes} ${heading}`);
  if (start === -1) throw new Error(`site: README.md has no "${hashes} ${heading}" section (the landing page reads it)`);
  const stop = new RegExp(`^#{1,${level}} `);
  let end = lines.length;
  let fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && stop.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** The top-level list items of `section`, each of which must start with a bold lead: `**Lead.** body`. */
export function leadList(section: string, where: string): { lead: string; body: string }[] {
  const items: string[] = [];
  let open = false;
  let fenced = false;
  for (const line of section.split("\n")) {
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      open = false;
      continue;
    }
    if (fenced) continue;
    if (/^(?:[-*] |\d+\. )/.test(line)) {
      items.push(line.replace(/^(?:[-*] |\d+\. )/, "").trim());
      open = true;
    } else if (line.trim() === "") {
      open = false;
    } else if (open) {
      const last = items.length - 1;
      items[last] = `${items[last]} ${line.trim()}`;
    }
  }
  if (items.length === 0) throw new Error(`site: ${where} has no list items`);
  return items.map((item, index) => {
    const match = /^\*\*(.+?)\*\*\s+(.+)$/.exec(item);
    if (!match) throw new Error(`site: ${where} item ${index + 1} does not start with **Lead.**`);
    return { lead: (match[1] ?? "").replace(/\.$/, ""), body: match[2] ?? "" };
  });
}

/** The first run of consecutive non-blank lines that is plain prose (not HTML, a heading, a fence, a table, a list or a quote). */
export function firstParagraph(section: string, where: string): string {
  let run: string[] = [];
  const prose = (lines: string[]) => lines.length > 0 && !/^(?:<|#|```|\||- |\* |>|\d+\. )/.test(lines[0] ?? "");
  for (const line of section.split("\n")) {
    if (line.trim() === "") {
      if (prose(run)) return run.join(" ");
      run = [];
    } else {
      run.push(line.trim());
    }
  }
  if (prose(run)) return run.join(" ");
  throw new Error(`site: ${where} has no paragraph`);
}

/** The trimmed content of the first ```<language> fence of `section`. */
export function firstCodeBlock(section: string, language: string, where: string): string {
  const lines = section.split("\n");
  const start = lines.findIndex(line => line.trim() === "```" + language);
  const end = start === -1 ? -1 : lines.findIndex((line, i) => i > start && line.trim() === "```");
  if (start === -1 || end === -1) throw new Error(`site: ${where} has no ${language} code block`);
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}
