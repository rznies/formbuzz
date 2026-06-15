/* FormBuzz Dashboard — Shared JavaScript */
(function () {
  "use strict";

  const CLERK_PK_META = document.querySelector('meta[name="clerk-publishable-key"]');
  const CLERK_PK = CLERK_PK_META ? CLERK_PK_META.getAttribute("content") : "";
  const API_BASE = window.location.origin;

  /* ── Toast Notifications ── */
  let toastContainer;
  function ensureToastContainer() {
    if (!toastContainer) {
      toastContainer = document.createElement("div");
      toastContainer.className = "toast-container";
      document.body.appendChild(toastContainer);
    }
  }

  function showToast(message, type) {
    type = type || "success";
    ensureToastContainer();
    var el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      el.style.transform = "translateX(24px)";
      el.style.transition = "all 0.3s ease";
      setTimeout(function () { el.remove(); }, 300);
    }, 3000);
  }

  /* ── Copy to Clipboard ── */
  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        showToast("Copied to clipboard!");
      });
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied to clipboard!");
    }
  }

  /* ── Sidebar Rendering ── */
  var NAV_ITEMS = [
    { href: "/dashboard", icon: "⚡", label: "Overview" },
    { href: "/dashboard/domains", icon: "🌐", label: "Domains" },
    { href: "/dashboard/webhooks", icon: "🔗", label: "Webhooks" },
    { href: "/dashboard/logs", icon: "📋", label: "Logs" }
  ];

  function renderSidebar() {
    var sidebarNav = document.getElementById("sidebar-nav");
    if (!sidebarNav) return;
    var currentPath = window.location.pathname.replace(/\/$/, "") || "/dashboard";
    var html = "";
    for (var i = 0; i < NAV_ITEMS.length; i++) {
      var item = NAV_ITEMS[i];
      var isActive = currentPath === item.href || (item.href !== "/dashboard" && currentPath.indexOf(item.href) === 0);
      html += '<a class="nav-link' + (isActive ? " active" : "") + '" href="' + item.href + '">';
      html += '<span class="icon">' + item.icon + '</span>';
      html += '<span>' + item.label + '</span>';
      html += '</a>';
    }
    sidebarNav.innerHTML = html;
  }

  /* ── Authenticated API Requests ── */
  function apiRequest(method, path, body) {
    return window.__clerkSession.getToken().then(function (token) {
      var opts = {
        method: method,
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        }
      };
      if (body !== undefined && body !== null) {
        opts.body = JSON.stringify(body);
      }
      return fetch(API_BASE + path, opts).then(function (res) {
        if (!res.ok) {
          return res.json().then(function (err) {
            throw new Error(err.error || "Request failed");
          });
        }
        return res.json();
      });
    });
  }

  /* ── Clerk Initialization ── */
  function initClerk(onReady) {
    if (!CLERK_PK) {
      console.error("[FormBuzz] Missing clerk-publishable-key meta tag");
      return;
    }

    var script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";
    script.crossOrigin = "anonymous";
    script.onload = function () {
      var clerk = new window.Clerk(CLERK_PK);
      clerk.load().then(function () {
        if (!clerk.user) {
          // Show sign-in UI
          var authEl = document.getElementById("clerk-auth");
          var appShell = document.getElementById("app-shell");
          if (appShell) appShell.classList.add("hidden");
          if (authEl) {
            authEl.parentElement.classList.remove("hidden");
            clerk.mountSignIn(authEl);
          }

          clerk.addListener(function (payload) {
            if (payload.user) {
              window.location.reload();
            }
          });
        } else {
          // User is signed in
          var authScreen = document.getElementById("auth-screen");
          var appShell = document.getElementById("app-shell");
          if (authScreen) authScreen.classList.add("hidden");
          if (appShell) appShell.classList.remove("hidden");

          window.__clerkSession = clerk.session;
          window.__clerkUser = clerk.user;

          // Populate user info in sidebar
          var userEl = document.getElementById("sidebar-user");
          if (userEl && clerk.user) {
            userEl.textContent = clerk.user.primaryEmailAddress
              ? clerk.user.primaryEmailAddress.emailAddress
              : clerk.user.firstName || "User";
          }

          // Logout handler
          var logoutBtn = document.getElementById("logout-btn");
          if (logoutBtn) {
            logoutBtn.addEventListener("click", function () {
              clerk.signOut().then(function () { window.location.reload(); });
            });
          }

          renderSidebar();
          if (typeof onReady === "function") onReady();
        }
      });
    };
    document.head.appendChild(script);
  }

  /* ── Loading State ── */
  function showLoading(containerId) {
    var el = document.getElementById(containerId);
    if (el) el.innerHTML = '<div class="loading-overlay"><div class="spinner"></div></div>';
  }

  function formatDate(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }

  /* ── Exports ── */
  window.FormBuzz = {
    initClerk: initClerk,
    apiRequest: apiRequest,
    showToast: showToast,
    copyToClipboard: copyToClipboard,
    renderSidebar: renderSidebar,
    showLoading: showLoading,
    formatDate: formatDate
  };
})();
