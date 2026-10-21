const CYCLE_MS = 4000;
const STEPS = 4;

export function initFlow(): void {
  const section = document.getElementById("how-it-works");
  const figure = section?.querySelector<HTMLElement>("figure.flow");
  if (!section || !figure) return;

  const steps = Array.from(section.querySelectorAll<HTMLElement>(".flow-step[data-step]"));
  let step = Number(figure.dataset.step) || 1;

  function setStep(next: number): void {
    step = next;
    figure?.setAttribute("data-step", String(next));
    for (const button of steps) button.setAttribute("aria-pressed", String(Number(button.dataset.step) === next));
  }

  let stopped = false;
  let paused = false;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reducedMotion.matches) {
    stopped = true;
    figure.querySelector("svg")?.pauseAnimations();
  }

  for (const button of steps) {
    button.addEventListener("click", () => {
      stopped = true;
      setStep(Number(button.dataset.step) || 1);
    });
  }

  section.addEventListener("pointerenter", () => {
    paused = true;
  });
  section.addEventListener("pointerleave", () => {
    paused = false;
  });
  section.addEventListener("focusin", () => {
    paused = true;
  });
  section.addEventListener("focusout", () => {
    paused = section.matches(":hover");
  });

  const timer = window.setInterval(() => {
    if (stopped) {
      window.clearInterval(timer);
      return;
    }
    if (!paused) setStep((step % STEPS) + 1);
  }, CYCLE_MS);
}
