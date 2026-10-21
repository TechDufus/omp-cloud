const COPIED_MS = 1500;

export function initCopy(): void {
  if (!document.querySelector("[data-copy]")) return;

  const timers = new WeakMap<HTMLElement, number>();

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>("[data-copy]");
    if (!button) return;
    const text = button.dataset.copyText ?? button.closest(".code")?.querySelector("code")?.textContent;
    if (!text) return;

    void navigator.clipboard.writeText(text).then(
      () => {
        const label = button.querySelector(".copy-label");
        const pending = timers.get(button);
        if (pending !== undefined) window.clearTimeout(pending);
        button.dataset.copied = "true";
        if (label) label.textContent = "Copied";
        timers.set(
          button,
          window.setTimeout(() => {
            delete button.dataset.copied;
            if (label) label.textContent = "Copy";
            timers.delete(button);
          }, COPIED_MS),
        );
      },
      () => {
        // A clipboard failure (permissions, insecure origin) is a silent no-op.
      },
    );
  });
}
