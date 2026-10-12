// Settings is one page with hash sections (#connection, #queue, …), like the
// web workspace's #/settings/<section>.
const panes = [...document.querySelectorAll(".opt-pane")];
const ids = panes.map(p => p.dataset.section);
function show() {
  const id = ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : "connection";
  for (const pane of panes) pane.hidden = pane.dataset.section !== id;
  for (const link of document.querySelectorAll(".opt-nav a[data-section]")) {
    if (link.dataset.section === id) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  const pane = document.getElementById(`pane-${id}`);
  document.getElementById("section-title").textContent = pane.dataset.title;
  document.getElementById("crumb-current").textContent = pane.dataset.title;
  document.getElementById("section-desc").textContent = pane.dataset.desc;
  document.title = `Cairn · ${pane.dataset.title}`;
}
addEventListener("hashchange", show);
show();
