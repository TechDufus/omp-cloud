export function initToc(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".toc-link"));
  const headings = Array.from(document.querySelectorAll<HTMLElement>(".doc-heading"));
  if (links.length === 0 || headings.length === 0) return;

  const byHref = new Map(links.map((link) => [link.getAttribute("href"), link]));
  const toc = links[0]?.closest<HTMLElement>(".toc");
  let current: HTMLAnchorElement | undefined;

  function activate(heading: HTMLElement | undefined): void {
    const target = heading ? byHref.get("#" + heading.id) : undefined;
    if (target === current) return;
    current = target;
    for (const link of links) {
      if (link === target) link.setAttribute("data-active", "true");
      else link.removeAttribute("data-active");
    }
    // A long TOC scrolls on its own: keep the active link inside it without scrolling the page.
    if (!toc || !target) return;
    const box = toc.getBoundingClientRect();
    const row = target.getBoundingClientRect();
    if (row.top < box.top) toc.scrollTop += row.top - box.top - 24;
    else if (row.bottom > box.bottom) toc.scrollTop += row.bottom - box.bottom + 24;
  }

  // The active heading is the last one whose top has crossed the line where an anchor jump puts it (the root's scroll-padding-top, below
  // the topbar). It is read from the layout on every scroll (coalesced per frame): an IntersectionObserver misses a jump (an anchor link,
  // a scroll restore) that carries headings across without any of them landing in its band.
  const LINE = (Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 8;
  let queued = false;
  function update(): void {
    queued = false;
    let active: HTMLElement | undefined;
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top > LINE) break;
      active = heading;
    }
    activate(active);
  }
  window.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}
