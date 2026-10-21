export function initTopbar(): void {
  const topbar = document.querySelector<HTMLElement>("header.topbar");
  if (!topbar) return;

  function update(): void {
    topbar?.setAttribute("data-scrolled", String(window.scrollY > 4));
  }

  update();
  window.addEventListener("scroll", update, { passive: true });
}
