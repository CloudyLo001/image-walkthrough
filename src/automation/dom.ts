/** Small DOM builders shared by the Automation page's views. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className: string, onClick: () => void) {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "2026-09-24" as "Sep 24", read as a local date rather than UTC midnight. */
export function formatDay(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** True while the user is typing somewhere inside `root`. */
export function isTypingIn(root: HTMLElement) {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    root.contains(active) &&
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    active.type !== "checkbox" &&
    active.type !== "radio"
  );
}
