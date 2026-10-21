import type { ReactNode } from "react";
import { ArrowRight, Check, Copy, Layers, LayoutDashboard, Lock, MessagesSquare, Moon, Send } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BLOB_URL, DOCS_INDEX_URL, REPO_URL, pageUrl, rootPrefix } from "../config";
import type { ImageRegistry } from "../assets";
import { firstCodeBlock, firstParagraph, leadList, readmeSection } from "../content";
import type { LinkRecord, RepoView } from "../links";
import { renderFragment } from "../markdown";
import type { RenderContext } from "../markdown";
import { Flow } from "./Flow";
import { CloudMark, GitHubMark } from "./icons";
import { ThemedShot, Win } from "./Window";

interface LandingProps {
  readme: string;
  version: string;
  repo: RepoView;
  links: LinkRecord[];
  images: ImageRegistry;
}

const FEATURE_ICONS: readonly LucideIcon[] = [Send, MessagesSquare, Moon, Layers, LayoutDashboard, Lock];

const DASHBOARD_SLIDES: readonly { name: string; label: string }[] = [
  { name: "thread", label: "Thread" },
  { name: "overview", label: "Overview" },
  { name: "threads", label: "Threads" },
  { name: "spend", label: "Spend" },
  { name: "vms", label: "VMs" },
  { name: "devices", label: "Devices" },
  { name: "logins", label: "Logins" },
  { name: "settings", label: "Settings" },
];

const RELEASES_URL = `${REPO_URL}/releases/latest`;

function CopyButton({ text }: { text: string }) {
  return (
    <button type="button" className="btn" data-variant="ghost" data-size="sm" data-copy data-copy-text={text}>
      <Copy size={14} className="copy-idle" aria-hidden="true" />
      <Check size={14} className="copy-done" aria-hidden="true" />
      <span className="copy-label">Copy</span>
    </button>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="l-section" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Landing({ readme, version, repo, links, images }: LandingProps) {
  const prefix = rootPrefix("");
  const ctx: RenderContext = { source: "README.md", url: "", repo, links, images };
  const fragment = (markdown: string): ReactNode => renderFragment(markdown, ctx);

  const quickstart = readmeSection(readme, "Quickstart", 2);
  const installCommand = firstCodeBlock(quickstart, "sh", "README.md ## Quickstart");
  const features = leadList(readmeSection(readme, "What you get", 2), "README.md ## What you get");
  const steps = leadList(readmeSection(readme, "How it works", 2), "README.md ## How it works");
  if (steps.length !== 4) {
    throw new Error(`site: README.md "## How it works" must list 4 steps (the landing diagram animates 4); found ${steps.length}`);
  }
  const caption = (heading: string): string => firstParagraph(readmeSection(readme, heading, 3), `README.md ### ${heading}`);
  const ompCaption = caption("In omp");
  const dashboardCaption = caption("The dashboard");
  const ternCaption = caption("In Tern");

  return (
    <>
      <main id="content">
        <section className="hero">
          <a className="badge" data-tone="accent" href={RELEASES_URL}>
            Open source · MIT · v{version}
          </a>
          <h1>
            Cloud agents for omp.
            <br />
            <span className="gradient-text">On your hardware.</span>
          </h1>
          <div className="hero-sub">
            {fragment("`/cloud <task>` hands your repo and conversation to an omp agent in its own KVM microVM. It asks you questions, sleeps when idle with its processes intact, and returns a branch.")}
          </div>
          <div className="pills">
            <span>KVM microVMs</span>
            <span>no Kubernetes</span>
            <span>returns a branch</span>
          </div>
          <div className="install">
            <span className="install-prompt" aria-hidden="true">
              $
            </span>
            <code className="install-cmd">{installCommand}</code>
            <CopyButton text={installCommand} />
          </div>
          <div className="hero-actions">
            <a className="btn" data-variant="accent" href={prefix + DOCS_INDEX_URL}>
              Read the docs
              <ArrowRight size={15} aria-hidden="true" />
            </a>
            <a className="btn" href={REPO_URL}>
              <GitHubMark size={15} />
              Star on GitHub
              <span data-stars hidden />
            </a>
          </div>
          <div className="hero-stage">
            <div className="hero-glow hero-glow-a" aria-hidden="true" />
            <div className="hero-glow hero-glow-b" aria-hidden="true" />
            <div className="hero-grid" aria-hidden="true" />
            <Win className="hero-win hero-dash" address="/ overview">
              <ThemedShot name="dashboard-overview" alt="The omp-cloud dashboard Overview page" images={images} prefix={prefix} />
            </Win>
            <Win className="hero-win hero-tui">
              <ThemedShot name="tui-cloud-tiles" alt="omp terminal: /cloud list draws each thread as a job tile" images={images} prefix={prefix} />
            </Win>
            <Win className="hero-win hero-tern">
              <ThemedShot name="tern-bell-tray" alt="Tern bell tray listing a finished turn and a waiting question" images={images} prefix={prefix} />
            </Win>
          </div>
        </section>

        <Section id="features" title="What you get">
          <div className="feature-grid">
            {features.map((item, index) => {
              const Icon = FEATURE_ICONS[index] ?? Check;
              return (
                <div className="card" key={item.lead}>
                  <div className="card-body">
                    <span className="feature-icon">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <div className="card-title">{item.lead}</div>
                    <div className="feature-body">{fragment(item.body)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section id="tour" title="A tour">
          <div className="tabs" role="tablist" aria-label="Tour">
            <button type="button" className="tab" role="tab" id="tour-tab-omp" aria-controls="tour-panel-omp" aria-selected="true" data-tab="omp" data-active="true">
              In omp
            </button>
            <button type="button" className="tab" role="tab" id="tour-tab-dashboard" aria-controls="tour-panel-dashboard" aria-selected="false" data-tab="dashboard">
              Dashboard
            </button>
            <button type="button" className="tab" role="tab" id="tour-tab-tern" aria-controls="tour-panel-tern" aria-selected="false" data-tab="tern">
              In Tern
            </button>
          </div>

          <div className="tour-panel" role="tabpanel" id="tour-panel-omp" aria-labelledby="tour-tab-omp" data-panel="omp">
            <div className="tour-caption prose">{fragment(ompCaption)}</div>
            <div className="tour-pair">
              <Win>
                <ThemedShot name="tui-cloud-tiles" alt="omp terminal: /cloud list draws each thread as a job tile" images={images} prefix={prefix} />
              </Win>
              <Win>
                <ThemedShot name="tui-question-card" alt="omp transcript: a launch card and a question card" images={images} prefix={prefix} />
              </Win>
            </div>
          </div>

          <div className="tour-panel" role="tabpanel" id="tour-panel-dashboard" aria-labelledby="tour-tab-dashboard" data-panel="dashboard">
            <div className="tour-caption prose">{fragment(dashboardCaption)}</div>
            <div className="segmented" role="group" aria-label="Dashboard page">
              {DASHBOARD_SLIDES.map((slide, index) => (
                <button
                  type="button"
                  className="segmented-option"
                  key={slide.name}
                  data-slide={slide.name}
                  data-active={index === 0 ? "true" : undefined}
                >
                  {slide.label}
                </button>
              ))}
            </div>
            <Win className="tour-dashboard" address="/ thread">
              <div className="slides">
                {DASHBOARD_SLIDES.map((slide, index) => (
                  <div className="slide" key={slide.name} data-slide={slide.name} hidden={index === 0 ? undefined : true}>
                    <ThemedShot name={`dashboard-${slide.name}`} alt={`The omp-cloud dashboard ${slide.label} page`} images={images} prefix={prefix} />
                  </div>
                ))}
              </div>
            </Win>
          </div>

          <div className="tour-panel" role="tabpanel" id="tour-panel-tern" aria-labelledby="tour-tab-tern" data-panel="tern">
            <div className="tour-caption prose">{fragment(ternCaption)}</div>
            <Win className="tour-tern">
              <ThemedShot name="tern-bell-tray" alt="Tern bell tray listing a finished turn and a waiting question" images={images} prefix={prefix} />
            </Win>
          </div>
        </Section>

        <Section id="how-it-works" title="How it works">
          <div className="how">
            <Flow />
            <ol className="flow-steps">
              {steps.map((step, index) => (
                <li key={step.lead}>
                  <button type="button" className="flow-step" data-step={index + 1} aria-pressed={index === 0}>
                    <span className="flow-step-num">{index + 1}</span>
                    <span className="flow-step-text">
                      <span className="flow-step-lead">{step.lead}</span>
                      <span className="flow-step-body">{fragment(step.body)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </Section>

        <Section id="quickstart" title="Quickstart">
          <div className="card">
            <div className="card-body prose">{fragment(quickstart)}</div>
          </div>
        </Section>

        <Section id="security" title="Security model">
          <div className="card">
            <div className="card-body prose">{fragment(readmeSection(readme, "Security model", 2))}</div>
          </div>
        </Section>

        <Section id="open-source" title="Open source">
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-label">GitHub stars</div>
              <div className="stat-value" data-stars>
                —
              </div>
              <div className="stat-foot">github.com/TechDufus/omp-cloud</div>
            </div>
            <div className="stat">
              <div className="stat-label">License</div>
              <div className="stat-value">MIT</div>
              <div className="stat-foot">Copyright (c) 2026 TechDufus</div>
            </div>
            <div className="stat">
              <div className="stat-label">Latest release</div>
              <div className="stat-value">
                <a href={RELEASES_URL}>v{version}</a>
              </div>
              <div className="stat-foot">GitHub releases</div>
            </div>
          </div>
          <div className="card open-source-card">
            <div className="card-body prose">{fragment(readmeSection(readme, "Related projects", 2))}</div>
          </div>
          <div className="open-source-actions">
            <a className="btn" data-variant="accent" href={REPO_URL}>
              <GitHubMark size={15} />
              View on GitHub
            </a>
            <a className="btn" href={prefix + pageUrl("CHANGELOG.md")}>
              Read the changelog
            </a>
            <a className="btn" href={`${REPO_URL}/issues/new`}>
              Open an issue
            </a>
          </div>
        </Section>
      </main>

      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="site-footer-brand">
            <CloudMark id="footer" size={20} />
            <span className="site-footer-name">omp-cloud</span>
            <span className="muted">Self-hosted cloud agents for omp.</span>
          </div>
          <nav className="site-footer-links" aria-label="Footer">
            <a href={prefix + DOCS_INDEX_URL}>Docs</a>
            <a href={prefix + pageUrl("CHANGELOG.md")}>Changelog</a>
            <a href={REPO_URL}>GitHub</a>
            <a href="https://github.com/can1357/oh-my-pi">omp ↗</a>
            <a href={`${BLOB_URL}LICENSE`}>MIT License</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
