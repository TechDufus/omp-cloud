import {
  Archive,
  Bot,
  Boxes,
  Code,
  DatabaseBackup,
  Download,
  GitBranch,
  Hammer,
  KeyRound,
  Layers,
  Link2,
  type LucideIcon,
  Network,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Wrench,
} from "lucide-react";

export interface NavItem {
  source: string;
  icon: LucideIcon;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/** The docs sidebar. Labels are each page's H1; every docs/*.md must be listed (validateNav). */
export const NAV: NavGroup[] = [
  {
    heading: "Start",
    items: [
      { source: "docs/install.md", icon: Download },
      { source: "docs/agent-setup.md", icon: Bot },
      { source: "docs/pairing.md", icon: Link2 },
    ],
  },
  {
    heading: "Use",
    items: [
      { source: "docs/commands.md", icon: SquareTerminal },
      { source: "docs/cloud-tool.md", icon: Wrench },
      { source: "docs/jobs.md", icon: Layers },
      { source: "docs/archive.md", icon: Archive },
    ],
  },
  {
    heading: "Operate",
    items: [
      { source: "docs/configuration.md", icon: SlidersHorizontal },
      { source: "docs/github.md", icon: GitBranch },
      { source: "docs/environments.md", icon: Boxes },
      { source: "docs/secrets-and-mcp.md", icon: KeyRound },
      { source: "docs/updating.md", icon: RefreshCw },
      { source: "docs/operations.md", icon: DatabaseBackup },
      { source: "docs/security.md", icon: ShieldCheck },
    ],
  },
  {
    heading: "Reference",
    items: [
      { source: "docs/architecture.md", icon: Network },
      { source: "docs/api.md", icon: Code },
      { source: "docs/development.md", icon: Hammer },
      { source: "CHANGELOG.md", icon: ScrollText },
    ],
  },
];

/** Throws one error naming every doc missing from `nav`, every non-page source and every duplicate. */
export function validateNav(nav: NavGroup[], docFiles: string[]): void {
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const group of nav) {
    for (const { source } of group.items) {
      if (listed.has(source)) problems.push(`site/nav.ts lists ${source} twice`);
      listed.add(source);
      if (!docFiles.includes(source) && source !== "CHANGELOG.md") {
        problems.push(`site/nav.ts lists ${source}, which is not a page source (docs/*.md or CHANGELOG.md)`);
      }
    }
  }
  for (const doc of docFiles) {
    if (!listed.has(doc)) problems.push(`site/nav.ts does not list ${doc}: add it to a group in NAV`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}
