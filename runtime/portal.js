/**
 * membership-webflow runtime: member self-service portal.
 *
 * Embed on a members-only page:
 *   <div data-membership-portal></div>
 *   <script src="https://YOUR-APP-HOST/runtime/portal.js" data-site="SITE_ID" defer></script>
 *
 * Lets a signed-in member edit app-managed profile fields, opt in/out of the directory, and request a tier
 * change. Tier requests are only recorded as "pending"; the site owner approves them in the App Panel.
 */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector('script[src*="runtime/portal.js"]');
  if (!script) return;
  var SITE = script.getAttribute("data-site") || "";
  var API = new URL(script.src).origin + "/api";
  var TOKEN_KEY = script.getAttribute("data-token-key") || "wf-member-token";
  var root = document.querySelector("[data-membership-portal]");
  if (!SITE || !root) return;

  var session = "";

  var style = document.createElement("style");
  style.textContent =
    ".mwp{max-width:560px;font:inherit}.mwp h3{margin:24px 0 8px}.mwp label{display:block;margin:10px 0 4px;font-weight:600}" +
    ".mwp input[type=text],.mwp textarea,.mwp select{width:100%;padding:8px 10px;border:1px solid #cfd4dc;border-radius:6px;font:inherit;box-sizing:border-box}" +
    ".mwp button{margin-top:12px;padding:9px 16px;border-radius:6px;border:0;background:#146ef5;color:#fff;font-weight:600;cursor:pointer}" +
    ".mwp .mwp-msg{margin-top:8px;font-size:14px;color:#1a7f37}.mwp .mwp-err{color:#b42318}.mwp .mwp-note{color:#555;font-size:14px}";
  document.head.appendChild(style);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function readMemberToken() {
    try {
      if (window.wfMemberToken) return String(window.wfMemberToken);
      var ls = window.localStorage.getItem(TOKEN_KEY);
      if (ls) return ls;
    } catch (e) {}
    var m = document.cookie.match(new RegExp("(?:^|; )" + TOKEN_KEY.replace(/[-.]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  function call(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: { Authorization: "Bearer " + session, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok) throw new Error(b.error || "Request failed");
        return b;
      });
    });
  }

  function flash(container, text, isErr) {
    var m = container.querySelector(".mwp-msg");
    if (!m) { m = el("div", "mwp-msg"); container.appendChild(m); }
    m.className = "mwp-msg" + (isErr ? " mwp-err" : "");
    m.textContent = text;
  }

  function render(me) {
    root.innerHTML = "";
    var wrap = el("div", "mwp");
    var tierById = {};
    me.tiers.forEach(function (t) { tierById[t.id] = t; });

    // Profile
    var profile = el("section");
    profile.appendChild(el("h3", null, "Profile"));
    var inputs = {};
    me.fields.forEach(function (f) {
      profile.appendChild(el("label", null, f.label));
      var input;
      if (f.type === "textarea") input = el("textarea");
      else if (f.type === "select") {
        input = el("select");
        var blank = el("option", null, "Select…");
        blank.value = "";
        input.appendChild(blank);
        f.options.forEach(function (o) { var opt = el("option", null, o); opt.value = o; input.appendChild(opt); });
      } else { input = el("input"); input.type = "text"; }
      input.value = me.values[f.key] || "";
      inputs[f.key] = input;
      profile.appendChild(input);
    });
    if (!me.fields.length) profile.appendChild(el("p", "mwp-note", "No profile fields are configured yet."));
    else {
      var save = el("button", null, "Save profile");
      save.addEventListener("click", function () {
        var values = {};
        Object.keys(inputs).forEach(function (k) { values[k] = inputs[k].value; });
        call("PUT", "/portal/profile", { values: values })
          .then(function () { flash(profile, "Saved.", false); })
          .catch(function (e) { flash(profile, e.message, true); });
      });
      profile.appendChild(save);
    }
    wrap.appendChild(profile);

    // Directory
    var dir = el("section");
    dir.appendChild(el("h3", null, "Member directory"));
    var cb = el("input");
    cb.type = "checkbox";
    cb.checked = me.directory.optedIn;
    var cbLabel = el("label", null, "");
    cbLabel.style.fontWeight = "400";
    cbLabel.appendChild(cb);
    cbLabel.appendChild(document.createTextNode(" List me in the member directory"));
    dir.appendChild(cbLabel);
    var status = el("p", "mwp-note", "");
    function setStatus(d) {
      status.textContent = d.optedIn ? (d.approved ? "You are listed." : "Awaiting approval by the site owner.") : "You are not listed.";
    }
    setStatus(me.directory);
    cb.addEventListener("change", function () {
      call("PUT", "/portal/directory", { optedIn: cb.checked })
        .then(function (r) { setStatus(r.directory); })
        .catch(function (e) { cb.checked = !cb.checked; flash(dir, e.message, true); });
    });
    dir.appendChild(status);
    wrap.appendChild(dir);

    // Tier
    var tierSec = el("section");
    tierSec.appendChild(el("h3", null, "Membership tier"));
    var current = me.member.tierId && tierById[me.member.tierId] ? tierById[me.member.tierId].name : "None";
    tierSec.appendChild(el("p", null, "Current tier: " + current));
    if (me.pendingRequest) {
      var pt = tierById[me.pendingRequest.toTierId];
      tierSec.appendChild(el("p", "mwp-note", "Pending request to move to " + (pt ? pt.name : "another tier") + "."));
      var cancel = el("button", null, "Cancel request");
      cancel.addEventListener("click", function () { call("DELETE", "/portal/tier-request").then(load).catch(function (e) { flash(tierSec, e.message, true); }); });
      tierSec.appendChild(cancel);
    } else {
      var sel = el("select");
      me.tiers.forEach(function (t) {
        if (t.id === me.member.tierId) return;
        var o = el("option", null, t.name);
        o.value = t.id;
        sel.appendChild(o);
      });
      tierSec.appendChild(sel);
      var req = el("button", null, "Request change");
      req.addEventListener("click", function () {
        call("POST", "/portal/tier-request", { toTierId: sel.value }).then(load).catch(function (e) { flash(tierSec, e.message, true); });
      });
      tierSec.appendChild(req);
    }
    wrap.appendChild(tierSec);
    root.appendChild(wrap);
  }

  function load() {
    return call("GET", "/portal/me").then(render).catch(function (e) { root.textContent = e.message; });
  }

  function start() {
    var token = readMemberToken();
    if (!token) { root.textContent = "Please sign in to manage your membership."; return; }
    fetch(API + "/session?site=" + encodeURIComponent(SITE), { headers: { "x-member-token": token } })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s.authenticated) { root.textContent = "Please sign in to manage your membership."; return; }
        session = s.sessionToken;
        load();
      })
      .catch(function () { root.textContent = "The membership portal is unavailable right now."; });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
