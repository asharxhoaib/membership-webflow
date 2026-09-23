/**
 * App Panel controller for membership-webflow (Designer Extension iframe).
 * Auth: site id + admin token (from the OAuth redirect query string, kept in sessionStorage, or pasted once).
 * All user-supplied data is rendered with textContent, never innerHTML.
 */
(function () {
  "use strict";

  var API_BASE = window.location.origin.replace(/\/designer-extension.*/, "");
  var state = {
    siteId: "",
    token: "",
    tiers: [],
    groups: [],
    members: { page: 1, total: 0, pageSize: 25 },
    selected: {},
    editingRuleId: null,
    pickedElementId: "",
    auditPage: 1,
  };

  function $(id) { return document.getElementById(id); }

  function h(tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "text") n.textContent = props[k];
      else if (k === "onclick") n.addEventListener("click", props[k]);
      else if (k === "onchange") n.addEventListener("change", props[k]);
      else n.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  function td(content) {
    var c = document.createElement("td");
    if (content instanceof Node) c.appendChild(content);
    else c.textContent = content == null ? "" : String(content);
    return c;
  }

  function notify(msg, isErr) {
    var n = $("notice");
    n.textContent = msg;
    n.className = "notice" + (isErr ? " err" : "");
    setTimeout(function () { n.className = "notice hidden"; }, 4000);
  }

  function api(path, method, body) {
    return fetch(API_BASE + "/api" + path, {
      method: method || "GET",
      headers: { "Content-Type": "application/json", "x-site-id": state.siteId, "x-admin-token": state.token },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok) throw new Error(b.error || r.statusText);
        return b;
      });
    });
  }

  function fail(e) { notify(e.message || String(e), true); }

  function fmtDate(s) {
    if (!s) return "";
    var d = new Date(s.indexOf("T") === -1 ? s.replace(" ", "T") + "Z" : s);
    return isNaN(d.getTime()) ? s : d.toLocaleString();
  }

  // ---------- bootstrap ----------

  function credentials() {
    var url = new URL(window.location.href);
    var site = url.searchParams.get("site");
    var token = url.searchParams.get("token");
    if (site && token) {
      try { sessionStorage.setItem("mw_site", site); sessionStorage.setItem("mw_token", token); } catch (e) {}
      // Remove the token from the address bar and history.
      window.history.replaceState({}, "", window.location.pathname);
    }
    try {
      state.siteId = sessionStorage.getItem("mw_site") || "";
      state.token = sessionStorage.getItem("mw_token") || "";
    } catch (e) {}
  }

  $("conn-save").addEventListener("click", function () {
    var site = $("conn-site").value.trim();
    var token = $("conn-token").value.trim();
    if (!site || !token) return notify("Both fields are required.", true);
    try { sessionStorage.setItem("mw_site", site); sessionStorage.setItem("mw_token", token); } catch (e) {}
    state.siteId = site;
    state.token = token;
    start();
  });

  function start() {
    if (!state.siteId || !state.token) {
      $("connect").classList.remove("hidden");
      $("main").classList.add("hidden");
      return;
    }
    api("/admin/tiers").then(function (r) {
      $("connect").classList.add("hidden");
      $("main").classList.remove("hidden");
      state.tiers = r.tiers;
      fillTierSelects();
      loadGroups();
      loadMembers();
      loadRequests();
      loadRules();
      renderTiers();
      loadFields();
      loadAudit();
    }).catch(function (e) {
      $("connect").classList.remove("hidden");
      $("main").classList.add("hidden");
      notify("Could not connect: " + e.message, true);
    });
  }

  // ---------- tabs ----------

  $("tabs").addEventListener("click", function (ev) {
    var tab = ev.target.closest("button[data-tab]");
    if (!tab) return;
    var name = tab.getAttribute("data-tab");
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) { b.classList.toggle("active", b === tab); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-panel]"), function (p) {
      p.classList.toggle("hidden", p.getAttribute("data-panel") !== name);
    });
  });

  function tierName(id) {
    var t = state.tiers.filter(function (x) { return x.id === id; })[0];
    return t ? t.name : "—";
  }

  function fillTierSelects() {
    var filter = $("m-tier-filter");
    var bulk = $("bulk-tier");
    filter.innerHTML = "";
    bulk.innerHTML = "";
    filter.appendChild(h("option", { value: "", text: "All tiers" }));
    bulk.appendChild(h("option", { value: "", text: "Choose tier…" }));
    state.tiers.forEach(function (t) {
      filter.appendChild(h("option", { value: t.id, text: t.name }));
      bulk.appendChild(h("option", { value: t.id, text: t.name }));
    });
    var g = $("g-tiers");
    g.innerHTML = "";
    state.tiers.forEach(function (t) {
      var cb = h("input", { type: "checkbox", value: t.id });
      g.appendChild(h("label", { class: "check" }, [cb, document.createTextNode(" " + t.name)]));
    });
  }

  // ---------- members ----------

  function loadMembers() {
    var qs = "?page=" + state.members.page + "&q=" + encodeURIComponent($("m-search").value.trim()) + "&tier=" + encodeURIComponent($("m-tier-filter").value);
    api("/admin/members" + qs).then(function (r) {
      state.members = { page: r.page, total: r.total, pageSize: r.pageSize };
      $("m-count").textContent = r.total + " members";
      $("m-page").textContent = "Page " + r.page + " of " + Math.max(1, Math.ceil(r.total / r.pageSize));
      var body = $("m-body");
      body.innerHTML = "";
      r.members.forEach(function (m) {
        var cb = h("input", { type: "checkbox" });
        cb.checked = !!state.selected[m.id];
        cb.addEventListener("change", function () { if (cb.checked) state.selected[m.id] = true; else delete state.selected[m.id]; });
        var dirText = !m.directoryOptedIn ? "Not opted in" : m.directoryApproved ? "Listed" : "Awaiting approval";
        var actions = h("div", { class: "row" }, [
          h("button", { class: "btn small", text: "Access groups", onclick: function () { overrideGroups(m); } }),
        ]);
        if (m.directoryOptedIn) {
          actions.appendChild(h("button", {
            class: "btn small",
            text: m.directoryApproved ? "Unlist" : "Approve listing",
            onclick: function () {
              api("/admin/members/" + m.id + "/directory-approval", "POST", { approved: !m.directoryApproved }).then(loadMembers).catch(fail);
            },
          }));
        }
        var who = h("div", {}, [h("div", { text: m.name || "(no name)" }), h("div", { class: "muted", text: m.email })]);
        var tr = h("tr", {}, [td(cb), td(who), td(m.tierName || "—"), td(fmtDate(m.joinedAt)), td(dirText), td(m.pendingRequests || ""), td(actions)]);
        body.appendChild(tr);
      });
    }).catch(fail);
  }

  function overrideGroups(m) {
    var input = window.prompt("Native access group slugs for " + (m.email || m.id) + " (comma separated).\nAvailable: " + state.groups.map(function (g) { return g.slug; }).join(", "), m.accessGroups.join(", "));
    if (input === null) return;
    var slugs = input.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    api("/admin/members/" + m.id + "/access-groups", "PUT", { accessGroups: slugs }).then(function () { notify("Access groups updated."); loadMembers(); }).catch(fail);
  }

  $("m-refresh").addEventListener("click", function () { state.members.page = 1; loadMembers(); });
  $("m-prev").addEventListener("click", function () { if (state.members.page > 1) { state.members.page--; loadMembers(); } });
  $("m-next").addEventListener("click", function () {
    if (state.members.page * state.members.pageSize < state.members.total) { state.members.page++; loadMembers(); }
  });
  $("m-all").addEventListener("change", function () {
    var on = $("m-all").checked;
    Array.prototype.forEach.call($("m-body").querySelectorAll("input[type=checkbox]"), function (cb) { cb.checked = on; cb.dispatchEvent(new Event("change")); });
  });
  $("m-sync").addEventListener("click", function () {
    notify("Re-sync started…");
    api("/admin/reconcile", "POST").then(function (r) { notify("Synced " + r.synced + " members, removed " + r.removed + "."); loadMembers(); }).catch(fail);
  });
  $("bulk-apply").addEventListener("click", function () {
    var ids = Object.keys(state.selected);
    var tierId = $("bulk-tier").value;
    if (!ids.length) return notify("Select at least one member.", true);
    if (!tierId) return notify("Choose a tier.", true);
    api("/admin/members/bulk-tier", "POST", { memberIds: ids, tierId: tierId }).then(function (r) {
      var bad = r.results.filter(function (x) { return !x.ok; });
      notify((r.results.length - bad.length) + " updated" + (bad.length ? ", " + bad.length + " failed (" + bad[0].error + ")" : "."), bad.length > 0);
      state.selected = {};
      $("m-all").checked = false;
      loadMembers();
    }).catch(fail);
  });

  // ---------- requests ----------

  function loadRequests() {
    api("/admin/requests?status=pending").then(function (r) {
      var badge = $("req-badge");
      badge.textContent = r.requests.length;
      badge.classList.toggle("hidden", r.requests.length === 0);
      var body = $("r-body");
      body.innerHTML = "";
      if (!r.requests.length) body.appendChild(h("tr", {}, [td("No pending requests.")]));
      r.requests.forEach(function (q) {
        function decide(approve) {
          api("/admin/requests/" + q.id + "/decision", "POST", { approve: approve }).then(function () {
            notify(approve ? "Request approved." : "Request rejected.");
            loadRequests(); loadMembers(); loadAudit();
          }).catch(fail);
        }
        var actions = h("div", { class: "row" }, [
          h("button", { class: "btn small primary", text: "Approve", onclick: function () { decide(true); } }),
          h("button", { class: "btn small danger", text: "Reject", onclick: function () { decide(false); } }),
        ]);
        body.appendChild(h("tr", {}, [td(q.memberName ? q.memberName + " (" + q.memberEmail + ")" : q.memberEmail), td(q.fromTierName || "—"), td(q.toTierName || "—"), td(fmtDate(q.createdAt)), td(actions)]));
      });
    }).catch(fail);
  }

  // ---------- gating rules ----------

  function selectedTierIds() {
    return Array.prototype.filter.call($("g-tiers").querySelectorAll("input"), function (i) { return i.checked; }).map(function (i) { return i.value; });
  }

  function refreshRuleForm() {
    var mode = $("g-mode").value;
    $("g-tiers").classList.toggle("hidden", mode === "blur_cta");
    $("g-days").classList.toggle("hidden", mode !== "after_days");
    $("g-deny").classList.toggle("hidden", mode === "blur_cta");
    $("g-html").classList.toggle("hidden", !$("g-critical").checked);
  }
  $("g-mode").addEventListener("change", refreshRuleForm);
  $("g-critical").addEventListener("change", refreshRuleForm);

  function newElementId() {
    var bytes = new Uint8Array(6);
    window.crypto.getRandomValues(bytes);
    return "g_" + Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  /**
   * Uses the Designer's element-selection API: reads the selected element, reuses its data-gate-id if present,
   * otherwise generates a stable id and writes it as a custom attribute so the rule survives republish.
   */
  $("g-pick").addEventListener("click", function () {
    if (!window.webflow || !window.webflow.getSelectedElement) return notify("Open this panel inside the Designer to pick an element.", true);
    window.webflow.getSelectedElement().then(function (el) {
      if (!el) return notify("Select an element on the canvas first.", true);
      if (!el.setCustomAttribute || !el.getCustomAttribute) return notify("This element type does not support custom attributes.", true);
      return Promise.resolve(el.getCustomAttribute("data-gate-id")).then(function (existing) {
        var id = existing || newElementId();
        var write = existing ? Promise.resolve() : el.setCustomAttribute("data-gate-id", id);
        return write.then(function () {
          state.pickedElementId = id;
          $("g-element").textContent = id;
          if (window.webflow.getCurrentPage) {
            return window.webflow.getCurrentPage().then(function (page) {
              return page.getSlug();
            }).then(function (slug) {
              if ($("g-page").value === "*" || !$("g-page").value) $("g-page").value = "/" + (slug || "");
            }).catch(function () {});
          }
        });
      });
    }).catch(function (e) { fail(e); });
  });

  function clearRuleForm() {
    state.editingRuleId = null;
    state.pickedElementId = "";
    $("g-form-title").textContent = "New rule";
    $("g-element").textContent = "No element selected";
    $("g-label").value = "";
    $("g-page").value = "*";
    $("g-mode").value = "tiers";
    $("g-days").value = "";
    $("g-deny").value = "hide";
    $("g-cta-text").value = "";
    $("g-cta-url").value = "";
    $("g-critical").checked = false;
    $("g-html").value = "";
    Array.prototype.forEach.call($("g-tiers").querySelectorAll("input"), function (i) { i.checked = false; });
    refreshRuleForm();
  }
  $("g-cancel").addEventListener("click", clearRuleForm);

  function editRule(r) {
    state.editingRuleId = r.id;
    state.pickedElementId = r.elementId;
    $("g-form-title").textContent = "Edit rule";
    $("g-element").textContent = r.elementId;
    $("g-label").value = r.label;
    $("g-page").value = r.pagePath;
    $("g-mode").value = r.mode;
    $("g-days").value = r.minDays;
    $("g-deny").value = r.denyAction;
    $("g-cta-text").value = r.ctaText;
    $("g-cta-url").value = r.ctaUrl;
    $("g-critical").checked = r.critical;
    $("g-html").value = r.protectedHtml;
    Array.prototype.forEach.call($("g-tiers").querySelectorAll("input"), function (i) { i.checked = r.tierIds.indexOf(i.value) !== -1; });
    refreshRuleForm();
  }

  $("g-save").addEventListener("click", function () {
    if (!state.pickedElementId) return notify("Pick an element first.", true);
    var body = {
      elementId: state.pickedElementId,
      pagePath: $("g-page").value.trim() || "*",
      label: $("g-label").value.trim(),
      mode: $("g-mode").value,
      tierIds: selectedTierIds(),
      minDays: Number($("g-days").value) || 0,
      denyAction: $("g-deny").value,
      ctaText: $("g-cta-text").value.trim(),
      ctaUrl: $("g-cta-url").value.trim(),
      critical: $("g-critical").checked,
      protectedHtml: $("g-html").value,
    };
    var req = state.editingRuleId ? api("/admin/gating/" + state.editingRuleId, "PUT", body) : api("/admin/gating", "POST", body);
    req.then(function () { notify("Rule saved."); clearRuleForm(); loadRules(); }).catch(fail);
  });

  function loadRules() {
    api("/admin/gating").then(function (r) {
      var body = $("g-body");
      body.innerHTML = "";
      if (!r.rules.length) body.appendChild(h("tr", {}, [td("No rules yet.")]));
      r.rules.forEach(function (rule) {
        var actions = h("div", { class: "row" }, [
          h("button", { class: "btn small", text: "Edit", onclick: function () { editRule(rule); } }),
          h("button", { class: "btn small danger", text: "Delete", onclick: function () {
            if (!window.confirm("Delete this rule?")) return;
            api("/admin/gating/" + rule.id, "DELETE").then(loadRules).catch(fail);
          } }),
        ]);
        var modeText = rule.mode === "tiers" ? "Tiers: " + rule.tierIds.map(tierName).join(", ") : rule.mode === "blur_cta" ? "Blur + CTA" : "After " + rule.minDays + " days";
        body.appendChild(h("tr", {}, [td(rule.label || "—"), td(rule.elementId), td(rule.pagePath), td(modeText), td(rule.critical ? "Yes" : "No"), td(actions)]));
      });
    }).catch(fail);
  }

  // ---------- tiers ----------

  function loadGroups() {
    api("/admin/access-groups").then(function (r) {
      state.groups = r.accessGroups;
      var sel = $("t-group");
      sel.innerHTML = "";
      sel.appendChild(h("option", { value: "", text: "No native group" }));
      state.groups.forEach(function (g) { sel.appendChild(h("option", { value: g.slug, text: g.name || g.slug })); });
      renderTiers();
    }).catch(function () { /* groups unavailable: tiers can still be managed without a mapping */ });
  }

  function renderTiers() {
    var body = $("t-body");
    body.innerHTML = "";
    state.tiers.forEach(function (t) {
      var sel = h("select");
      sel.appendChild(h("option", { value: "", text: "No native group" }));
      var known = false;
      state.groups.forEach(function (g) {
        var o = h("option", { value: g.slug, text: g.name || g.slug });
        if (g.slug === t.nativeGroupSlug) { o.selected = true; known = true; }
        sel.appendChild(o);
      });
      if (t.nativeGroupSlug && !known) { var o2 = h("option", { value: t.nativeGroupSlug, text: t.nativeGroupSlug }); o2.selected = true; sel.appendChild(o2); }
      var rank = h("input", { type: "number", value: String(t.rank) });
      var actions = h("div", { class: "row" }, [
        h("button", { class: "btn small primary", text: "Save", onclick: function () {
          api("/admin/tiers/" + t.id, "PUT", { name: t.name, rank: Number(rank.value) || 0, nativeGroupSlug: sel.value || null }).then(refreshTiers).catch(fail);
        } }),
        h("button", { class: "btn small danger", text: "Delete", onclick: function () {
          if (!window.confirm("Delete tier " + t.name + "? Members on it become unassigned.")) return;
          api("/admin/tiers/" + t.id, "DELETE").then(refreshTiers).catch(fail);
        } }),
      ]);
      body.appendChild(h("tr", {}, [td(t.name), td(rank), td(sel), td(actions)]));
    });
  }

  function refreshTiers() {
    return api("/admin/tiers").then(function (r) { state.tiers = r.tiers; fillTierSelects(); renderTiers(); notify("Tiers updated. A member re-sync is running."); });
  }

  $("t-add").addEventListener("click", function () {
    var name = $("t-name").value.trim();
    if (!name) return notify("Name is required.", true);
    api("/admin/tiers", "POST", { name: name, rank: Number($("t-rank").value) || 0, nativeGroupSlug: $("t-group").value || null })
      .then(function () { $("t-name").value = ""; $("t-rank").value = ""; return refreshTiers(); }).catch(fail);
  });

  // ---------- profile / directory fields ----------

  function loadFields() {
    api("/admin/profile-fields").then(function (r) {
      var body = $("f-body");
      body.innerHTML = "";
      r.fields.forEach(function (f) {
        var vis = h("input", { type: "checkbox" });
        vis.checked = f.directoryVisible;
        var fil = h("input", { type: "checkbox" });
        fil.checked = f.filterable;
        function save() {
          api("/admin/profile-fields/" + f.id, "PUT", { label: f.label, type: f.type, options: f.options, directoryVisible: vis.checked, filterable: fil.checked, sortOrder: f.sortOrder }).catch(fail);
        }
        vis.addEventListener("change", save);
        fil.addEventListener("change", save);
        var del = h("button", { class: "btn small danger", text: "Delete", onclick: function () {
          if (!window.confirm("Delete field " + f.label + "? Stored member values remain but are no longer shown.")) return;
          api("/admin/profile-fields/" + f.id, "DELETE").then(loadFields).catch(fail);
        } });
        body.appendChild(h("tr", {}, [td(f.key), td(f.label), td(f.type), td(vis), td(fil), td(del)]));
      });
    }).catch(fail);
  }

  $("f-add").addEventListener("click", function () {
    api("/admin/profile-fields", "POST", {
      key: $("f-key").value.trim(),
      label: $("f-label").value.trim(),
      type: $("f-type").value,
      options: $("f-options").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean),
      directoryVisible: $("f-visible").checked,
      filterable: $("f-filter").checked,
    }).then(function () {
      ["f-key", "f-label", "f-options"].forEach(function (id) { $(id).value = ""; });
      loadFields();
    }).catch(fail);
  });

  // ---------- audit ----------

  var SOURCES = { request_approval: "Request approved", override: "Manual override", bulk: "Bulk change", sync: "Sync" };

  function loadAudit() {
    api("/admin/audit?page=" + state.auditPage).then(function (r) {
      $("a-page").textContent = "Page " + r.page;
      var body = $("a-body");
      body.innerHTML = "";
      r.entries.forEach(function (e) {
        body.appendChild(h("tr", {}, [td(fmtDate(e.createdAt)), td(e.memberEmail || e.memberId), td((e.fromTier || "—") + " → " + (e.toTier || "—")), td(SOURCES[e.source] || e.source), td(e.actor), td(e.detail)]));
      });
      $("a-next").disabled = r.entries.length < 50;
    }).catch(fail);
  }
  $("a-prev").addEventListener("click", function () { if (state.auditPage > 1) { state.auditPage--; loadAudit(); } });
  $("a-next").addEventListener("click", function () { state.auditPage++; loadAudit(); });

  credentials();
  refreshRuleForm();
  start();
})();
