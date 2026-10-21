export function initSidebar(): void {
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const menu = document.querySelector<HTMLElement>(".topbar-menu");
  const scrim = document.querySelector<HTMLElement>(".drawer-scrim");
  if (!sidebar || !menu || !scrim) return;

  function setOpen(open: boolean): void {
    sidebar?.setAttribute("data-open", String(open));
    if (scrim) scrim.hidden = !open;
  }

  menu.addEventListener("click", () => setOpen(true));
  scrim.addEventListener("click", () => setOpen(false));
  sidebar.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sidebar.getAttribute("data-open") === "true") setOpen(false);
  });
}
