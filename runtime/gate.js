/**
 * membership-webflow runtime: client-side content gating.
 *
 * Embed (site-wide footer code):
 *   <script src="https://YOUR-APP-HOST/runtime/gate.js" data-site="SITE_ID" defer></script>
 *
 * Elements carry data-gate-id="<stable id>" (injected by the App Panel). Elements marked critical are
 * NOT trusted to client-side hiding: their protected HTML is fetched from /api/gated-content/{ruleId}
 * only after the server verifies the member's tier. The gate fails closed: if rules cannot be loaded,
 * gated elements stay hidden.
 */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector('script[src*="runtime/gate.js"]');
  if (!script) return;
  var SITE = script.getAttribute("data-site") || "";
  var API = new URL(script.src).origin + "/api";
  var TOKEN_KEY = script.getAttribute("data-token-key") || "wf-member-token";
  var SESSION_KEY = "mw_session_" + SITE;

  // Hide every gated element until its decision is applied (prevents a flash of protected content).
  var style = document.createElement("style");
  style.textContent =
    "[data-gate-id]:not([data-gate-ready]){visibility:hidden!important}" +
    ".mw-gate-blur{filter:blur(8px);pointer-events:none;user-select:none}" +
    ".mw-gate-wrap{position:relative}" +
    ".mw-gate-cta{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;z-index:2}" +
    ".mw-gate-cta a,.mw-gate-cta-inline a{display:inline-block;padding:10px 18px;border-radius:6px;background:#146ef5;color:#fff;text-decoration:none;font-weight:600}" +
    ".mw-gate-cta-inline{padding:24px;text-align:center}";
  document.head.appendChild(style);

  /**
   * The Webflow member token is read from (in order): window.wfMemberToken, localStorage[data-token-key],
   * a cookie of the same name. Sites can also call window.MembershipGate.setMemberToken(token).
   */
  function readMemberToken() {
    try {
      if (window.wfMemberToken) return String(window.wfMemberToken);
      var ls = window.localStorage.getItem(TOKEN_KEY);
      if (ls) return ls;
    } catch (e) {}
    var m = document.cookie.match(new RegExp("(?:^|; )" + TOKEN_KEY.replace(/[-.]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  function getSession() {
    try {
      var cached = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || "null");
      if (cached && cached.expires > Date.now()) return Promise.resolve(cached.token);
    } catch (e) {}
    var token = readMemberToken();
    if (!token) return Promise.resolve("");
    return fetch(API + "/session?site=" + encodeURIComponent(SITE), { headers: { "x-member-token": token } })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s.authenticated || !s.sessionToken) return "";
        try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: s.sessionToken, expires: Date.now() + 50 * 60000 })); } catch (e) {}
        return s.sessionToken;
      })
      .catch(function () { return ""; });
  }

  function findEl(elementId) {
    return document.querySelector('[data-gate-id="' + String(elementId).replace(/"/g, "") + '"]');
  }

  function ctaNode(d, cls) {
    var box = document.createElement("div");
    box.className = cls;
    if (d.ctaText) {
      var a = document.createElement("a");
      a.textContent = d.ctaText;
      a.href = d.ctaUrl || "#";
      box.appendChild(a);
    }
    return box;
  }

  function deny(el, d) {
    if (d.critical) el.innerHTML = ""; // never leave protected markup in the DOM for critical rules
    if (d.denyAction === "hide") {
      el.style.display = "none";
    } else if (d.denyAction === "cta") {
      el.innerHTML = "";
      el.appendChild(ctaNode(d, "mw-gate-cta-inline"));
    } else {
      // blur + CTA overlay
      var inner = document.createElement("div");
      inner.className = "mw-gate-blur";
      while (el.firstChild) inner.appendChild(el.firstChild);
      if (d.critical && !inner.firstChild) inner.style.minHeight = "120px";
      el.classList.add("mw-gate-wrap");
      el.appendChild(inner);
      el.appendChild(ctaNode(d, "mw-gate-cta"));
    }
  }

  function apply(decisions, session) {
    var pending = [];
    decisions.forEach(function (d) {
      var el = findEl(d.elementId);
      if (!el) return;
      if (!d.allowed) {
        deny(el, d);
      } else if (d.critical) {
        pending.push(
          fetch(API + "/gated-content/" + encodeURIComponent(d.ruleId), { headers: { Authorization: "Bearer " + session } })
            .then(function (r) { if (!r.ok) throw new Error("denied"); return r.json(); })
            .then(function (b) { el.innerHTML = b.html; })
            .catch(function () { deny(el, Object.assign({}, d, { allowed: false })); })
        );
      }
    });
    return Promise.all(pending).then(function () {
      var all = document.querySelectorAll("[data-gate-id]");
      for (var i = 0; i < all.length; i++) all[i].setAttribute("data-gate-ready", "1");
    });
  }

  function run() {
    if (!SITE) return;
    getSession()
      .then(function (session) {
        var headers = session ? { Authorization: "Bearer " + session } : {};
        return fetch(API + "/gating/rules?site=" + encodeURIComponent(SITE) + "&page=" + encodeURIComponent(location.pathname), { headers: headers })
          .then(function (r) { if (!r.ok) throw new Error("rules"); return r.json(); })
          .then(function (b) { return apply(b.decisions || [], session); });
      })
      .catch(function () { /* fail closed: gated elements stay hidden */ });
  }

  window.MembershipGate = {
    setMemberToken: function (t) {
      window.wfMemberToken = t;
      try { window.sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
      run();
    },
    getSession: getSession,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
