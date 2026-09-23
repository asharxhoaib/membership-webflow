/**
 * membership-webflow runtime: member directory.
 *
 * Embed:
 *   <div data-membership-directory></div>
 *   <script src="https://YOUR-APP-HOST/runtime/directory.js" data-site="SITE_ID" defer></script>
 *
 * Renders opted-in, owner-approved members with search, filters on filterable profile fields and pagination
 * (GET /api/directory?page=). Class names are prefixed mwd- so the grid can be restyled from the site's CSS.
 */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector('script[src*="runtime/directory.js"]');
  if (!script) return;
  var SITE = script.getAttribute("data-site") || "";
  var API = new URL(script.src).origin + "/api";
  var root = document.querySelector("[data-membership-directory]");
  if (!SITE || !root) return;

  var state = { page: 1, q: "", filters: {} };
  var filtersLoaded = false;

  var style = document.createElement("style");
  style.textContent =
    ".mwd-bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.mwd-bar input,.mwd-bar select{padding:8px 10px;border:1px solid #cfd4dc;border-radius:6px;font:inherit}" +
    ".mwd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}" +
    ".mwd-card{border:1px solid #e1e4ea;border-radius:8px;padding:16px}.mwd-name{font-weight:600;margin-bottom:8px}" +
    ".mwd-field{font-size:14px;margin:2px 0}.mwd-field b{font-weight:600}" +
    ".mwd-pager{display:flex;gap:12px;align-items:center;justify-content:center;margin-top:16px}.mwd-pager button{padding:6px 14px;border-radius:6px;border:1px solid #cfd4dc;background:#fff;cursor:pointer}.mwd-pager button:disabled{opacity:.4;cursor:default}" +
    ".mwd-empty{padding:24px;text-align:center;color:#666}";
  document.head.appendChild(style);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  root.innerHTML = "";
  var bar = el("div", "mwd-bar");
  var search = el("input");
  search.type = "search";
  search.placeholder = "Search members";
  bar.appendChild(search);
  var grid = el("div", "mwd-grid");
  var pager = el("div", "mwd-pager");
  root.appendChild(bar);
  root.appendChild(grid);
  root.appendChild(pager);

  var timer = null;
  search.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(function () { state.q = search.value.trim(); state.page = 1; load(); }, 250);
  });

  function buildFilters(filters) {
    filters.forEach(function (f) {
      var input;
      if (f.type === "select") {
        input = el("select");
        var all = el("option", null, "All " + f.label);
        all.value = "";
        input.appendChild(all);
        f.options.forEach(function (o) { var opt = el("option", null, o); opt.value = o; input.appendChild(opt); });
        input.addEventListener("change", function () { state.filters[f.key] = input.value; state.page = 1; load(); });
      } else {
        input = el("input");
        input.placeholder = f.label;
        input.addEventListener("change", function () { state.filters[f.key] = input.value.trim(); state.page = 1; load(); });
      }
      bar.appendChild(input);
    });
  }

  function render(data) {
    grid.innerHTML = "";
    if (!data.members.length) grid.appendChild(el("div", "mwd-empty", "No members found."));
    data.members.forEach(function (m) {
      var card = el("div", "mwd-card");
      card.appendChild(el("div", "mwd-name", m.name));
      data.fields.forEach(function (f) {
        if (!m.fields[f.key]) return;
        var row = el("div", "mwd-field");
        row.appendChild(el("b", null, f.label + ": "));
        row.appendChild(document.createTextNode(m.fields[f.key]));
        card.appendChild(row);
      });
      grid.appendChild(card);
    });
    pager.innerHTML = "";
    var prev = el("button", null, "Previous");
    prev.disabled = data.page <= 1;
    prev.addEventListener("click", function () { state.page = data.page - 1; load(); });
    var next = el("button", null, "Next");
    next.disabled = data.page >= data.totalPages;
    next.addEventListener("click", function () { state.page = data.page + 1; load(); });
    pager.appendChild(prev);
    pager.appendChild(el("span", null, "Page " + data.page + " of " + data.totalPages));
    pager.appendChild(next);
  }

  function load() {
    var qs = new URLSearchParams({ site: SITE, page: String(state.page) });
    if (state.q) qs.set("q", state.q);
    Object.keys(state.filters).forEach(function (k) { if (state.filters[k]) qs.set("f_" + k, state.filters[k]); });
    fetch(API + "/directory?" + qs.toString())
      .then(function (r) { if (!r.ok) throw new Error("directory"); return r.json(); })
      .then(function (data) {
        if (!filtersLoaded) { filtersLoaded = true; buildFilters(data.filters); }
        render(data);
      })
      .catch(function () { grid.innerHTML = ""; grid.appendChild(el("div", "mwd-empty", "The directory is unavailable right now.")); });
  }

  load();
})();
