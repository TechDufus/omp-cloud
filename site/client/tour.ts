const FADE_MS = 400;
const ADVANCE_MS = 5000;
const MIN_VISIBLE = 0.3;

export function initTour(): void {
  const tour = document.getElementById("tour");
  if (!tour) return;

  const tabs = Array.from(tour.querySelectorAll<HTMLElement>(".tab[data-tab]"));
  const panels = Array.from(tour.querySelectorAll<HTMLElement>(".tour-panel[data-panel]"));
  const options = Array.from(tour.querySelectorAll<HTMLElement>(".segmented-option[data-slide]"));
  const slides = Array.from(tour.querySelectorAll<HTMLElement>(".slide[data-slide]"));
  const address = tour.querySelector<HTMLElement>(".win-addr");
  const dashboard = tour.querySelector<HTMLElement>('.tour-panel[data-panel="dashboard"]');
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function selectTab(name: string | undefined): void {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.setAttribute("data-active", String(active));
      tab.setAttribute("aria-selected", String(active));
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
  }

  // The server HTML shows every panel so the page works without JS; the first tab starts active.
  selectTab(tabs[0]?.dataset.tab);
  for (const tab of tabs) tab.addEventListener("click", () => selectTab(tab.dataset.tab));

  const names = options.map((option) => option.dataset.slide ?? "");
  const fading = new Map<HTMLElement, number>();
  let current = Math.max(
    0,
    options.findIndex((option) => option.getAttribute("data-active") === "true"),
  );

  function showSlide(index: number): void {
    const name = names[index];
    if (name === undefined || index === current) return;
    for (const option of options) option.setAttribute("data-active", String(option.dataset.slide === name));
    for (const slide of slides) {
      const timer = fading.get(slide);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        fading.delete(slide);
      }
      if (slide.dataset.slide === name) {
        slide.removeAttribute("data-leaving");
        slide.hidden = false;
      } else if (!slide.hidden) {
        slide.setAttribute("data-leaving", "true");
        fading.set(
          slide,
          window.setTimeout(() => {
            slide.hidden = true;
            slide.removeAttribute("data-leaving");
            fading.delete(slide);
          }, FADE_MS),
        );
      }
    }
    const label = address?.querySelector("b") ?? address;
    if (label) label.textContent = `/ ${name}`;
    current = index;
  }

  for (const [index, option] of options.entries()) option.addEventListener("click", () => showSlide(index));

  if (options.length < 2 || !dashboard) return;

  // Auto-advance runs only while the dashboard panel is on screen and the visitor has not touched it; the first click or key inside the
  // panel ends it for good. Choosing the Dashboard tab does not count: it is the only way to reach the panel.
  let interacted = false;
  let inView = false;
  const stop = (): void => {
    interacted = true;
  };
  dashboard.addEventListener("click", stop);
  dashboard.addEventListener("keydown", stop);

  new IntersectionObserver(
    ([entry]) => {
      inView = entry !== undefined && (entry.intersectionRatio >= MIN_VISIBLE || entry.intersectionRect.height >= window.innerHeight * MIN_VISIBLE);
    },
    { threshold: [0, MIN_VISIBLE, 0.6, 1] },
  ).observe(tour);

  const timer = window.setInterval(() => {
    if (interacted) {
      window.clearInterval(timer);
      return;
    }
    if (reducedMotion.matches || dashboard.hidden || !inView) return;
    showSlide((current + 1) % options.length);
  }, ADVANCE_MS);
}
