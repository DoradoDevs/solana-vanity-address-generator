/*
 * Quiet Technical behaviours, v2.3.0. Every component looks right and
 * reads correctly without this file; it adds keyboard details,
 * announcements and the few things CSS cannot do. One external file, no
 * dependencies, safe under script-src 'self' (it never writes a style
 * attribute or an HTML string; positions go through the style DOM API).
 *
 *   <script src="/system.js" defer></script>
 *
 * Who loads it: Bait, the Watchpost site, VanityGrinder, Outpost and Cloud
 * Scanner (React apps without a component library load it too: it is
 * delegated, so it works on markup React renders later). PDFree and Memori
 * take the same behaviour from Radix and do not load it. Debate is React
 * Native and has no DOM.
 *
 * What it does, by attribute:
 *   [data-theme-control]        radio group (system/light/dark): stores the choice
 *   [data-copy]                 copy a value; announces "Copied". Bare
 *                               inside .secret: that secret's own value,
 *                               never the mask and never another secret;
 *                               inside .code, the <pre> shown. Sets
 *                               data-qt-copied for 2s (.icon--copy and
 *                               .icon--done swap)
 *   [data-clipboard-clear]      a button that empties the clipboard
 *   [aria-busy="true"]          on a button: blocks activation, announces
 *   [aria-disabled="true"]      on a button or link: blocks activation
 *   [role="tablist"][data-qt-tabs]
 *                               arrow keys, Home and End; shows the chosen
 *                               panel (a tab list a framework owns is left
 *                               alone: no data-qt-tabs, no handling)
 *     [data-qt-sync="<key>"]    on such a list: every list with that key
 *                               follows the choice (tabs matched by
 *                               data-value), remembered in localStorage
 *   input[aria-keyshortcuts="/"]
 *                               "/" focuses it unless the person is typing
 *   .chips                      fades the edge with more (data-overflow);
 *                               button.chip[aria-pressed] toggles, one at a
 *                               time with data-qt-chips="one";
 *                               data-qt-filter="<id>" hides that box's
 *                               children whose data-tags miss the chosen
 *                               data-value, and says the count; rows
 *                               added later follow the same choice
 *   [data-qt-empty-for="<id>"]  shown while that filtered box shows none
 *   .nav--settle                data-scrolled once the page has scrolled
 *   [data-qt-spy]               the link to the section in view gets
 *                               aria-current="location"; a followed link
 *                               stays current until the person scrolls
 *   .spot                       --spot-x / --spot-y follow a fine pointer
 *   .tip                        warm: the next tooltip within 300ms of one
 *                               that was read shows at once (data-qt-warm
 *                               on <html>)
 *   .walk__step[data-lines][aria-controls]
 *                               click or focus marks those lines of the
 *                               .lines it names (data-hit, aria-current)
 *   .menu[popover]              placed under its button; arrow keys; a
 *                               fallback where the popover API is missing
 *   .side-panel[popover]        a tool panel that is a sheet on phones:
 *                               focus moves into it when it opens
 *   .tip                        Escape hides the tooltip; hidden while its
 *                               button's menu is open
 *   .nav__menu                  closes on Escape, link choice, outside click,
 *                               and when focus moves out of it
 *   .truncate                   a value cut short gets its full text as a title
 *   <details>                   all opened for printing, closed again after
 *   [data-dialog]               opens the <dialog> it names
 *   .secret                     show and hide a masked value
 *   .data-table-wrap, .code pre,
 *   .console                    focusable and named when they scroll
 *
 *   window.QT.toast(message, {tone})   window.QT.announce(message)
 *   window.QT.setTheme(value)          window.QT.selectTab(tab, focus)
 *   window.QT.init(root)               set up markup added later (not
 *                                      needed for menus, copy or tabs keys)
 *   window.QT.strings                  the words it uses; translate them
 */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  /* CSS can tell the script is running (an open menu stays hidden until it
     is placed). */
  root.setAttribute("data-qt-js", "");
  var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

  /* Every word this file shows or says. A product with other languages
     replaces these after load: QT.strings.copied = "Kopiert". */
  var strings = {
    copied: "Copied",
    copiedToast: "Copied to the clipboard",
    pressToCopy: isMac ? "Press ⌘C" : "Press Ctrl+C",
    copyFailed: isMac
      ? "Could not copy automatically. The text is selected; press Command C."
      : "Could not copy automatically. The text is selected; press Control C.",
    clipboardCleared: "Clipboard cleared",
    working: "Working",
    scrollable: "Scrollable content",
    show: "Show",
    hide: "Hide",
    shown: "{n} shown",
  };

  /* ── Announcements: one polite live region, created at load so screen
     readers are already listening when the first message arrives. ── */
  var toastRegion = null;
  var toastTimers = [];

  function pauseToasts() {
    toastTimers.forEach(function (t) {
      t.pause();
    });
  }

  function resumeToasts() {
    toastTimers.forEach(function (t) {
      t.resume();
    });
  }

  function ensureRegion() {
    if (toastRegion && doc.body.contains(toastRegion)) return toastRegion;
    toastRegion = doc.querySelector(".toasts");
    if (!toastRegion) {
      toastRegion = doc.createElement("div");
      toastRegion.className = "toasts";
      doc.body.appendChild(toastRegion);
    }
    toastRegion.setAttribute("role", "status");
    toastRegion.setAttribute("aria-live", "polite");
    /* role=status implies aria-atomic=true, which would read every toast
       still shown again with each new one: only the new one is read. */
    toastRegion.setAttribute("aria-atomic", "false");
    toastRegion.setAttribute("aria-relevant", "additions");
    /* Registered once per region: toasts wait while pointed at or focused. */
    toastRegion.addEventListener("pointerenter", pauseToasts);
    toastRegion.addEventListener("pointerleave", resumeToasts);
    toastRegion.addEventListener("focusin", pauseToasts);
    toastRegion.addEventListener("focusout", resumeToasts);
    return toastRegion;
  }

  var MAX_TOASTS = 3;
  var TOAST_MS = 5000;

  /* A toast confirms something the person just did. It is not for errors
     (those stay in the page beside the thing that failed). */
  function toast(message, options) {
    var region = ensureRegion();
    var tone = options && options.tone;
    var el = doc.createElement("div");
    el.className = "toast" + (tone ? " toast--" + tone : "");
    el.textContent = message;
    region.appendChild(el);

    var remaining = TOAST_MS;
    var started = 0;
    var timer = null;
    var entry = {
      el: el,
      pause: function () {
        if (timer === null) return;
        window.clearTimeout(timer);
        timer = null;
        remaining = Math.max(1000, remaining - (Date.now() - started));
      },
      resume: function () {
        if (timer !== null || !el.parentNode) return;
        started = Date.now();
        timer = window.setTimeout(leave, remaining);
      },
    };

    function remove() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      toastTimers = toastTimers.filter(function (t) {
        return t !== entry;
      });
      if (el.parentNode) el.parentNode.removeChild(el);
      syncToastSpace();
    }

    function leave() {
      timer = null;
      el.setAttribute("data-leaving", "");
      window.setTimeout(remove, 200);
    }

    entry.remove = remove;
    toastTimers.push(entry);
    while (toastTimers.length > MAX_TOASTS) toastTimers[0].remove();
    entry.resume();
    syncToastSpace();
    return el;
  }

  /* While toasts are shown, the page keeps their height free at the bottom
     (--qt-toasts-h feeds scroll-padding), and a control that takes focus
     under them is scrolled clear (DESIGN.md: toasts never cover the
     focused element). */
  var toastObserver = typeof ResizeObserver === "function" ? new ResizeObserver(syncToastSpace) : null;

  function toastSpace() {
    if (!toastRegion || !toastRegion.childElementCount) return 0;
    var r = toastRegion.getBoundingClientRect();
    return r.height ? Math.ceil(window.innerHeight - r.top) : 0;
  }

  function syncToastSpace() {
    if (toastObserver && toastRegion && !toastRegion.hasAttribute("data-qt-observed")) {
      toastRegion.setAttribute("data-qt-observed", "");
      toastObserver.observe(toastRegion);
    }
    var space = toastSpace();
    if (space) root.style.setProperty("--qt-toasts-h", space + "px");
    else root.style.removeProperty("--qt-toasts-h");
    /* A toast that arrives over the control that already has focus moves
       the page, not the focus. */
    keepClear(doc.activeElement);
  }

  function keepClear(el) {
    var space = toastSpace();
    if (!space || !el || el === doc.body || !el.getBoundingClientRect || (toastRegion && toastRegion.contains(el))) return;
    var r = el.getBoundingClientRect();
    var limit = window.innerHeight - space - 8;
    if (r.bottom > limit) window.scrollBy(0, r.bottom - limit);
  }

  /* After the browser's own focus scroll: it runs after focusin and, with
     smooth scrolling, would cancel a scroll started here. So wait until the
     page has stopped moving (two still frames), then clear the toasts. */
  doc.addEventListener("focusin", function (event) {
    var el = event.target;
    if (!toastSpace()) return;
    var last = -1;
    var still = 0;
    var frames = 0;
    function tick() {
      if (doc.activeElement !== el) return;
      var y = window.scrollY;
      still = y === last ? still + 1 : 0;
      last = y;
      if (still >= 2 || ++frames > 60) keepClear(el);
      else window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  });

  /* Say something without showing a toast (busy states, results). The
     region is created at start, empty, so a screen reader is already
     watching it when the first message arrives. */
  var quiet = null;

  function ensureQuiet() {
    if (quiet && doc.body.contains(quiet)) return quiet;
    quiet = doc.createElement("div");
    quiet.className = "sr-only";
    quiet.setAttribute("role", "status");
    quiet.setAttribute("aria-live", "polite");
    doc.body.appendChild(quiet);
    return quiet;
  }

  function announce(message) {
    ensureQuiet();
    quiet.textContent = "";
    window.setTimeout(function () {
      quiet.textContent = message;
    }, 60);
  }

  /* ── Theme control: a radio group with values system, light, dark (and
     tinted where a product has it). ── */
  function currentTheme() {
    var t = root.getAttribute("data-theme");
    if (t === "pink") return "tinted";
    return t === "light" || t === "dark" || t === "tinted" ? t : "system";
  }

  /* The browser's own bar follows the chosen theme: every theme-color meta
     takes the page colour while a theme is forced, and gets its own value
     back when the choice returns to the system. */
  function syncThemeColor() {
    var metas = doc.querySelectorAll('meta[name="theme-color"]');
    if (!metas.length) return;
    var forced = root.hasAttribute("data-theme");
    var paper = forced ? getComputedStyle(doc.body).backgroundColor : "";
    metas.forEach(function (meta) {
      if (!meta.hasAttribute("data-qt-original")) meta.setAttribute("data-qt-original", meta.getAttribute("content") || "");
      meta.setAttribute("content", forced ? paper : meta.getAttribute("data-qt-original"));
    });
  }

  function setTheme(value) {
    if (value === "pink") value = "tinted";
    if (value === "light" || value === "dark" || value === "tinted") {
      root.setAttribute("data-theme", value);
    } else {
      root.removeAttribute("data-theme");
    }
    syncThemeColor();
    try {
      if (value === "system") window.localStorage.removeItem("theme");
      else window.localStorage.setItem("theme", value);
    } catch (e) {
      /* Storage blocked: the choice lasts for this page only. */
    }
    syncThemeControls();
  }

  function syncThemeControls() {
    var t = currentTheme();
    doc.querySelectorAll("[data-theme-control] input[type=radio]").forEach(function (input) {
      input.checked = input.value === t;
    });
  }

  doc.addEventListener("change", function (event) {
    var input = event.target;
    if (input.matches && input.matches("[data-theme-control] input[type=radio]")) {
      setTheme(input.value);
    }
  });

  /* ── Busy and disabled: block activation in the capture phase, before
     any framework handler, so a double click cannot submit twice. ── */
  doc.addEventListener(
    "click",
    function (event) {
      var blocked = event.target.closest && event.target.closest('[aria-busy="true"], [aria-disabled="true"]');
      if (blocked && blocked.matches("a, button, input, .btn, [role=button], [role=menuitem], [role=tab]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );

  doc.addEventListener(
    "submit",
    function (event) {
      var submitter = event.submitter;
      if (submitter && (submitter.getAttribute("aria-busy") === "true" || submitter.getAttribute("aria-disabled") === "true")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );

  /* When a button becomes busy or stops being busy, say so. The words come
     from data-busy-label ("Saving") and data-done-label ("Saved"). */
  var busyObserver = new MutationObserver(function (records) {
    records.forEach(function (record) {
      var el = record.target;
      if (record.attributeName !== "aria-busy") return;
      if (el.getAttribute("aria-busy") === "true") {
        announce(el.getAttribute("data-busy-label") || strings.working);
      } else if (record.oldValue === "true" && el.getAttribute("data-done-label")) {
        announce(el.getAttribute("data-done-label"));
      }
    });
  });

  /* ── Copy ──
     data-copy="#id"   copies the text of that element (or its value)
     data-copy         inside .code, .copyfield or .secret copies its value
     Prompts ($), output lines and anything marked [data-copy-skip] are left
     out. Nothing is cleared behind the person's back: a page that holds a
     secret offers a visible [data-clipboard-clear] button instead. */
  function copyText(source) {
    if (!source) return "";
    if ("value" in source && typeof source.value === "string") return source.value;
    var clone = source.cloneNode(true);
    clone.querySelectorAll(".prompt, .output, [data-copy-skip]").forEach(function (n) {
      n.remove();
    });
    return clone.textContent.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
  }

  /* A bare data-copy copies the value of the component it sits in. A
     .secret is resolved first (it contains a .copyfield whose first value
     is the mask), so each Copy button copies its own secret, never the
     bullets and never the first secret on the page. */
  function sourceFor(button) {
    var ref = button.getAttribute("data-copy");
    if (ref) return doc.querySelector(ref);
    var secret = button.closest(".secret");
    if (secret) return secret.querySelector(".secret__value");
    var box = button.closest(".code, .copyfield");
    if (!box) return null;
    /* A block with tabs holds one <pre> per choice: copy the one shown. */
    return box.querySelector("pre:not([hidden]), .copyfield__value:not(.secret__mask)");
  }

  var labelTimers = new WeakMap();
  var copiedTimers = new WeakMap();

  function flashLabel(button, text) {
    var label = button.querySelector("[data-label]") || button;
    if (!label.hasAttribute("data-original")) label.setAttribute("data-original", label.textContent);
    label.textContent = text;
    window.clearTimeout(labelTimers.get(button));
    labelTimers.set(
      button,
      window.setTimeout(function () {
        label.textContent = label.getAttribute("data-original");
      }, 2000)
    );
  }

  doc.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-copy]");
    if (!button) return;
    var source = sourceFor(button);
    var text = copyText(source);
    if (!text) return;

    function done() {
      flashLabel(button, strings.copied);
      button.setAttribute("data-qt-copied", "");
      window.clearTimeout(copiedTimers.get(button));
      copiedTimers.set(
        button,
        window.setTimeout(function () {
          button.removeAttribute("data-qt-copied");
        }, 2000)
      );
      toast(button.getAttribute("data-copied") || strings.copiedToast, { tone: "ok" });
    }

    function failed() {
      /* Select the value so the keyboard shortcut or the system menu still works. */
      if (source && window.getSelection) {
        var range = doc.createRange();
        range.selectNodeContents(source);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      flashLabel(button, strings.pressToCopy);
      announce(strings.copyFailed);
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, failed);
    } else {
      failed();
    }
  });

  doc.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-clipboard-clear]");
    if (!button || !navigator.clipboard || !window.isSecureContext) return;
    navigator.clipboard.writeText("").then(function () {
      toast(button.getAttribute("data-cleared") || strings.clipboardCleared, { tone: "ok" });
    });
  });

  /* ── Secrets: masked until shown. The button's label says what it will
     do next (Show, Hide), so it is not also a toggle button: a pressed
     state and a changing name together read as a contradiction. ── */
  doc.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-secret-toggle]");
    if (!button) return;
    var box = button.closest(".secret");
    if (!box) return;
    var show = box.getAttribute("data-revealed") !== "true";
    box.setAttribute("data-revealed", show ? "true" : "false");
    button.removeAttribute("aria-pressed");
    var label = button.querySelector("[data-label]") || button;
    label.textContent = show ? strings.hide : strings.show;
  });

  /* ── Tabs: automatic activation, arrow keys follow the reading
     direction, Home and End. Only lists marked data-qt-tabs: a tab list
     rendered by React, Radix or a router keeps its own state, and a second
     owner would fight it. ── */
  var TABLIST = '[role="tablist"][data-qt-tabs]';

  function selectTab(tab, focus, quiet) {
    var list = tab.closest('[role="tablist"]');
    if (!list) return;
    list.querySelectorAll('[role="tab"]').forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      var panel = doc.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
    if (!quiet) syncTabs(list, tab);
  }

  doc.addEventListener("click", function (event) {
    var tab = event.target.closest && event.target.closest('[role="tab"]');
    if (!tab || !tab.closest(TABLIST)) return;
    if (tab.getAttribute("aria-disabled") !== "true") selectTab(tab, false);
  });

  doc.addEventListener("keydown", function (event) {
    var tab = event.target.closest && event.target.closest('[role="tab"]');
    var list = tab && tab.closest(TABLIST);
    if (!list) return;
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    var i = tabs.indexOf(tab);
    var rtl = getComputedStyle(tab).direction === "rtl";
    var next = null;
    if (event.key === "ArrowRight") next = tabs[(i + (rtl ? -1 : 1) + tabs.length) % tabs.length];
    else if (event.key === "ArrowLeft") next = tabs[(i + (rtl ? 1 : -1) + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    if (next) {
      event.preventDefault();
      /* Focus, then a real click: a framework listening for clicks on its
         tabs sees the same event a pointer would give it. */
      next.focus();
      next.click();
    }
  });

  /* ── v2.3: the reference bar. Each part below is optional: without it
     the markup still reads correctly and only the refinement is lost. ── */

  /* Search: "/" focuses the page's search field (the input that declares
     aria-keyshortcuts="/"), unless the person is already typing. */
  function isTyping(el) {
    if (!el || el === doc.body) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag !== "INPUT") return false;
    return !/^(button|checkbox|radio|submit|reset|range|color|file|image)$/.test(el.type);
  }

  function openModal() {
    try {
      return doc.querySelector("dialog[open]:modal");
    } catch (e) {
      return null; /* :modal unknown: an engine this old has no inert either */
    }
  }

  /* The key is taken only when focus really moved: a field that is inert,
     behind an open modal or hidden is skipped, and if focus() did not land
     (a framework moved it back) the "/" goes where it was going. */
  doc.addEventListener("keydown", function (event) {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    if (isTyping(doc.activeElement)) return;
    var modal = openModal();
    var fields = doc.querySelectorAll('input[aria-keyshortcuts="/"]');
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (!field.getClientRects().length || field.disabled) continue;
      if (field.closest("[inert]") || (modal && !modal.contains(field))) continue;
      field.focus();
      if (doc.activeElement !== field) return;
      event.preventDefault();
      field.select();
      return;
    }
  });

  /* Filter chips: a chip is a toggle (aria-pressed). In a row marked
     data-qt-chips="one" choosing one releases the rest. A row with
     data-qt-filter="<id>" also filters that container's children by
     their data-tags (a chip with data-value="" shows everything) and
     announces how many are shown. */
  doc.addEventListener("click", function (event) {
    var chip = event.target.closest && event.target.closest("button.chip[aria-pressed]");
    var row = chip && chip.closest(".chips");
    if (!row || chip.getAttribute("aria-disabled") === "true") return;
    if (row.getAttribute("data-qt-chips") === "one") {
      row.querySelectorAll("button.chip[aria-pressed]").forEach(function (c) {
        c.setAttribute("aria-pressed", c === chip ? "true" : "false");
      });
    } else {
      chip.setAttribute("aria-pressed", chip.getAttribute("aria-pressed") === "true" ? "false" : "true");
    }
    var target = row.getAttribute("data-qt-filter");
    var box = target && doc.getElementById(target);
    if (!box) return;
    var wanted = [];
    row.querySelectorAll('button.chip[aria-pressed="true"]').forEach(function (c) {
      var value = c.getAttribute("data-value");
      if (value) wanted.push(value);
    });
    /* Kept on the box, so a row added later is held to the same choice. */
    box.setAttribute("data-qt-active", wanted.join(" "));
    var shown = 0;
    Array.prototype.forEach.call(box.children, function (item) {
      if (matchFilter(item, wanted)) shown++;
    });
    syncEmpty(box, shown);
    announce(strings.shown.replace("{n}", String(shown)));
  });

  function matchFilter(item, wanted) {
    var tags = (item.getAttribute("data-tags") || "").split(/\s+/);
    var show =
      !wanted.length ||
      wanted.some(function (w) {
        return tags.indexOf(w) !== -1;
      });
    item.hidden = !show;
    return show;
  }

  /* [data-qt-empty-for="<id>"]: shown while that filtered box shows nothing. */
  function syncEmpty(box, shown) {
    doc.querySelectorAll("[data-qt-empty-for]").forEach(function (el) {
      if (el.getAttribute("data-qt-empty-for") === box.id) el.hidden = shown > 0;
    });
  }

  /* A row added to a filtered box (a live finding, an .arrive row). */
  function filterAdded(node) {
    var box = node.parentElement;
    if (!box || !box.hasAttribute("data-qt-active")) return;
    var active = box.getAttribute("data-qt-active");
    if (matchFilter(node, active ? active.split(" ") : [])) syncEmpty(box, 1);
  }

  /* The chips row fades only the edge that has more (data-overflow). */
  function syncChips(row) {
    var max = row.scrollWidth - row.clientWidth;
    var pos = Math.abs(row.scrollLeft);
    var edges = [];
    if (max > 1 && pos > 1) edges.push("start");
    if (max > 1 && pos < max - 1) edges.push("end");
    if (edges.length) row.setAttribute("data-overflow", edges.join(" "));
    else row.removeAttribute("data-overflow");
  }

  doc.addEventListener(
    "scroll",
    function (event) {
      var el = event.target;
      if (el && el.nodeType === 1 && el.matches(".chips")) schedule(el);
    },
    { passive: true, capture: true }
  );

  /* A chip that takes focus while partly scrolled out (and under the edge
     fade) is brought fully in: the browser leaves a partly visible one
     where it is. "nearest" keeps the scroll-padding clear of the fade. */
  doc.addEventListener("focusin", function (event) {
    var chip = event.target;
    if (!chip.closest || !chip.closest(".chips:not(.chips--wrap)")) return;
    if (chip.scrollIntoView) chip.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  /* Tab lists marked data-qt-sync="<key>" (a code block's OS or package
     manager) stay on the same choice, matched by data-value, and the
     choice is remembered on this device. */
  function syncKey(list) {
    return list.getAttribute("data-qt-sync");
  }

  function storedChoice(key) {
    try {
      return window.localStorage.getItem("qt-sync:" + key);
    } catch (e) {
      return null;
    }
  }

  function tabByValue(list, value) {
    var tabs = list.querySelectorAll('[role="tab"][data-value]');
    for (var i = 0; i < tabs.length; i++) if (tabs[i].getAttribute("data-value") === value) return tabs[i];
    return null;
  }

  function syncTabs(list, tab) {
    var key = syncKey(list);
    var value = tab.getAttribute("data-value");
    if (!key || !value) return;
    try {
      window.localStorage.setItem("qt-sync:" + key, value);
    } catch (e) {
      /* Storage refused (private mode, a policy): the choice lasts the page. */
    }
    doc.querySelectorAll('[role="tablist"][data-qt-sync]').forEach(function (other) {
      if (other === list || syncKey(other) !== key) return;
      var match = tabByValue(other, value);
      if (match && match.getAttribute("aria-selected") !== "true") selectTab(match, false, true);
    });
  }

  /* Scroll-spy contents: in a nav marked data-qt-spy, the link to the
     section in view (the last one whose top has passed a line a quarter of
     the way down, or the last section at the very end) is
     aria-current="location". */
  var spyHeld = null;

  function holdSpy(hash) {
    spyHeld = null;
    if (!hash || hash.length < 2) return;
    doc.querySelectorAll("[data-qt-spy] a[href]").forEach(function (a) {
      if (a.getAttribute("href") === hash) spyHeld = a;
    });
  }

  function syncSpy() {
    doc.querySelectorAll("[data-qt-spy]").forEach(function (nav) {
      if (spyHeld && nav.contains(spyHeld)) {
        nav.querySelectorAll('[aria-current="location"]').forEach(function (a) {
          if (a !== spyHeld) a.removeAttribute("aria-current");
        });
        spyHeld.setAttribute("aria-current", "location");
        return;
      }
      var links = Array.prototype.filter.call(nav.querySelectorAll('a[href^="#"]'), function (a) {
        return a.getAttribute("href").length > 1;
      });
      var line = window.innerHeight * 0.25;
      var atEnd = window.innerHeight + window.scrollY >= root.scrollHeight - 2;
      var current = null;
      links.forEach(function (a) {
        var id = a.getAttribute("href").slice(1);
        try {
          id = decodeURIComponent(id);
        } catch (e) {
          /* A malformed escape: use the id as written. */
        }
        var target = doc.getElementById(id);
        if (!target) return;
        if (atEnd || target.getBoundingClientRect().top <= line) current = a;
      });
      links.forEach(function (a) {
        if (a === current) a.setAttribute("aria-current", "location");
        else if (a.getAttribute("aria-current") === "location") a.removeAttribute("aria-current");
      });
    });
  }

  /* A contents link that was followed (clicked, or the hash changed) is the
     current one, even where the page cannot scroll its section to the top
     (the last short sections): the "at the end" rule waits until the
     person scrolls again. */
  doc.addEventListener("click", function (event) {
    var a = event.target.closest && event.target.closest('[data-qt-spy] a[href^="#"]');
    if (a) holdSpy(a.getAttribute("href"));
  });

  window.addEventListener("hashchange", function () {
    holdSpy(window.location.hash);
    syncSpy();
  });

  function releaseSpy() {
    spyHeld = null;
  }

  window.addEventListener("wheel", releaseSpy, { passive: true });
  window.addEventListener("touchstart", releaseSpy, { passive: true });
  doc.addEventListener("keydown", function (event) {
    if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown| )$/.test(event.key) && !isTyping(doc.activeElement)) releaseSpy();
  });

  /* The top bar settles: its hairline shows once the page has scrolled.
     Read in an animation frame, never while the script is evaluated: a
     read of scrollY or of a box at that point forces a whole layout. A
     page with no settling bar and no contents reads nothing. */
  var navFrame = 0;

  function needsNav() {
    return !!doc.querySelector(".nav--settle, [data-qt-spy]");
  }

  function syncNav() {
    navFrame = 0;
    var navs = doc.querySelectorAll(".nav--settle");
    if (navs.length) {
      var scrolled = window.scrollY > 0;
      navs.forEach(function (nav) {
        if (scrolled) nav.setAttribute("data-scrolled", "");
        else nav.removeAttribute("data-scrolled");
      });
    }
    syncSpy();
  }

  function queueNav() {
    if (!navFrame && needsNav()) navFrame = window.requestAnimationFrame(syncNav);
  }

  window.addEventListener(
    "scroll",
    function () {
      queueNav();
    },
    { passive: true }
  );

  /* Spotlight: a .spot tile's hairline brightens near the pointer. Fine
     pointers, motion allowed; the position goes through the CSSOM. */
  var spotQuery = window.matchMedia
    ? window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)")
    : null;
  var spotFrame = 0;
  var spotAt = null;

  doc.addEventListener(
    "pointermove",
    function (event) {
      if (!spotQuery || !spotQuery.matches || event.pointerType !== "mouse") return;
      var tile = event.target.closest && event.target.closest(".spot");
      if (!tile) return;
      spotAt = { tile: tile, x: event.clientX, y: event.clientY };
      if (spotFrame) return;
      spotFrame = window.requestAnimationFrame(function () {
        spotFrame = 0;
        var r = spotAt.tile.getBoundingClientRect();
        spotAt.tile.style.setProperty("--spot-x", Math.round(spotAt.x - r.left) + "px");
        spotAt.tile.style.setProperty("--spot-y", Math.round(spotAt.y - r.top) + "px");
      });
    },
    { passive: true }
  );

  /* Warm tooltips: after a tooltip has been read (hovered past its 500ms
     delay), the next one within 300ms shows at once. */
  var warmTimer = 0;
  var tipSince = 0;

  doc.addEventListener(
    "pointerover",
    function (event) {
      var tip = event.target.closest && event.target.closest(".tip");
      if (!tip || tip.contains(event.relatedTarget)) return;
      window.clearTimeout(warmTimer);
      tipSince = Date.now();
    },
    { passive: true }
  );

  doc.addEventListener(
    "pointerout",
    function (event) {
      var el = event.target.closest && event.target;
      if (!el) return;
      var tile = el.closest(".spot");
      if (tile && !tile.contains(event.relatedTarget)) {
        if (spotAt && spotAt.tile === tile) spotAt = null;
        if (spotFrame) {
          window.cancelAnimationFrame(spotFrame);
          spotFrame = 0;
        }
        tile.style.removeProperty("--spot-x");
        tile.style.removeProperty("--spot-y");
      }
      var tip = el.closest(".tip");
      if (!tip || tip.contains(event.relatedTarget)) return;
      if (!root.hasAttribute("data-qt-warm") && Date.now() - tipSince < 500) return;
      root.setAttribute("data-qt-warm", "");
      window.clearTimeout(warmTimer);
      warmTimer = window.setTimeout(function () {
        root.removeAttribute("data-qt-warm");
      }, 300);
    },
    { passive: true }
  );

  /* Walkthrough: choosing a step (click or focus) marks its lines,
     data-lines="1-2,5", in the .lines it controls. */
  function parseLines(spec) {
    var hit = {};
    (spec || "").split(",").forEach(function (part) {
      var m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
      if (!m) return;
      var from = Number(m[1]);
      var to = m[2] ? Number(m[2]) : from;
      for (var n = from; n <= to && n - from < 500; n++) hit[n] = true;
    });
    return hit;
  }

  function chooseStep(step) {
    var walk = step.closest(".walk");
    if (!walk) return;
    walk.querySelectorAll(".walk__step").forEach(function (s) {
      if (s === step) s.setAttribute("aria-current", "step");
      else s.removeAttribute("aria-current");
    });
    var lines = doc.getElementById(step.getAttribute("aria-controls"));
    if (!lines) return;
    var hit = parseLines(step.getAttribute("data-lines"));
    Array.prototype.forEach.call(lines.querySelectorAll(".line"), function (line, i) {
      if (hit[i + 1]) {
        line.setAttribute("data-hit", "");
        line.setAttribute("aria-current", "true");
      } else {
        line.removeAttribute("data-hit");
        line.removeAttribute("aria-current");
      }
    });
  }

  doc.addEventListener("click", function (event) {
    var step = event.target.closest && event.target.closest(".walk__step");
    if (step) chooseStep(step);
  });

  doc.addEventListener("focusin", function (event) {
    var step = event.target.closest && event.target.closest(".walk__step");
    if (step) chooseStep(step);
  });

  /* ── Menus: a popover under its button, aligned to its start edge,
     flipped above when there is no room below. Where the popover API is
     missing (Firefox before 125, Safari before 17) the same markup works
     through data-open, with Escape, outside click, Tab and item choice
     closing it and focus going back to the button. ── */
  var hasPopover = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

  function invokerFor(menu) {
    return menu.id ? doc.querySelector('[popovertarget="' + menu.id + '"]') : null;
  }

  function placeMenu(menu) {
    var invoker = invokerFor(menu);
    if (!invoker) return;
    var r = invoker.getBoundingClientRect();
    var rtl = getComputedStyle(invoker).direction === "rtl";
    var gap = 6;
    var width = menu.offsetWidth;
    var height = menu.offsetHeight;
    var left = rtl ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    var top = r.bottom + gap;
    if (top + height > window.innerHeight - 8 && r.top - gap - height > 8) top = r.top - gap - height;
    menu.style.setProperty("left", left + "px");
    menu.style.setProperty("top", top + "px");
    /* Without the popover API the menu is not in the top layer: an
       ancestor with containment or a transform becomes its containing
       block and shifts it. Measure and correct. */
    var m = menu.getBoundingClientRect();
    if (Math.abs(m.left - left) > 0.5 || Math.abs(m.top - top) > 0.5) {
      menu.style.setProperty("left", left + (left - m.left) + "px");
      menu.style.setProperty("top", top + (top - m.top) + "px");
    }
    /* Where the button was when the menu was placed: a scroll that leaves
       it there (one queued before the menu opened, or a scroll inside the
       menu) does not close the menu. */
    menu.qtAnchor = r.left + "," + r.top;
    menu.setAttribute("data-placed", "");
  }

  /* A tooltip on the button that opened a menu would sit over the menu. */
  function setTipHidden(invoker, hidden) {
    var tip = invoker && invoker.closest(".tip");
    if (!tip) return;
    if (hidden) tip.setAttribute("data-tip-dismissed", "");
    else tip.removeAttribute("data-tip-dismissed");
  }

  function menuItems(menu) {
    return Array.prototype.slice.call(menu.querySelectorAll(".menu__item:not([aria-disabled='true'])"));
  }

  function isOpen(menu) {
    return hasPopover ? menu.matches(":popover-open") : menu.hasAttribute("data-open");
  }

  function openMenus() {
    return Array.prototype.slice.call(doc.querySelectorAll(hasPopover ? ".menu:popover-open" : ".menu[data-open]"));
  }

  /* Focus the first item once the menu is placed (and so visible). If the
     engine has not painted it as visible yet, focus() is ignored: try again
     on the next frame. */
  function focusFirst(menu, tries) {
    var items = menuItems(menu);
    if (!items[0] || !isOpen(menu)) return;
    items[0].focus();
    if (!menu.contains(doc.activeElement) && tries > 0) {
      window.requestAnimationFrame(function () {
        focusFirst(menu, tries - 1);
      });
    }
  }

  function opened(menu) {
    var invoker = invokerFor(menu);
    if (invoker) invoker.setAttribute("aria-expanded", "true");
    setTipHidden(invoker, true);
    placeMenu(menu);
    focusFirst(menu, 3);
  }

  function closeMenu(menu, returnFocus) {
    if (!isOpen(menu)) return;
    if (hasPopover) menu.hidePopover();
    else menu.removeAttribute("data-open");
    menu.removeAttribute("data-placed");
    var invoker = invokerFor(menu);
    if (invoker) {
      invoker.setAttribute("aria-expanded", "false");
      setTipHidden(invoker, false);
      if (returnFocus) invoker.focus();
    }
  }

  if (hasPopover) {
    /* Placed before the first paint: "toggle" fires a task later, after the
       menu may already have been drawn at the corner. Until placed, CSS
       keeps it invisible. */
    doc.addEventListener(
      "beforetoggle",
      function (event) {
        var menu = event.target;
        if (!menu.classList || !menu.classList.contains("menu")) return;
        if (event.newState === "open") {
          menu.removeAttribute("data-placed");
          window.requestAnimationFrame(function () {
            if (isOpen(menu)) placeMenu(menu);
          });
        }
      },
      true
    );

    doc.addEventListener(
      "toggle",
      function (event) {
        var menu = event.target;
        /* A tool panel opened as a sheet: focus goes into it. */
        if (menu.classList && menu.classList.contains("side-panel") && event.newState === "open") {
          var first = menu.querySelector(".side-panel__close, a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex='0']");
          if (first) first.focus();
          return;
        }
        if (!menu.classList || !menu.classList.contains("menu")) return;
        if (event.newState === "open") opened(menu);
        else {
          menu.removeAttribute("data-placed");
          var invoker = invokerFor(menu);
          if (invoker) invoker.setAttribute("aria-expanded", "false");
          setTipHidden(invoker, false);
        }
      },
      true
    );
  } else {
    doc.addEventListener("click", function (event) {
      var invoker = event.target.closest && event.target.closest("[popovertarget]");
      var menu = invoker && doc.getElementById(invoker.getAttribute("popovertarget"));
      if (menu && menu.classList.contains("menu")) {
        var wasOpen = isOpen(menu);
        openMenus().forEach(function (m) {
          closeMenu(m, false);
        });
        if (!wasOpen) {
          menu.setAttribute("data-open", "");
          opened(menu);
        }
        return;
      }
      if (!(event.target.closest && event.target.closest(".menu"))) {
        openMenus().forEach(function (m) {
          closeMenu(m, false);
        });
      }
    });
  }

  doc.addEventListener("keydown", function (event) {
    var menu = event.target.closest && event.target.closest(".menu");
    if (!menu) return;
    var items = menuItems(menu);
    var i = items.indexOf(doc.activeElement);
    var next = null;
    if (event.key === "ArrowDown") next = items[(i + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(i - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items[items.length - 1];
    else if (event.key === "Escape" && !hasPopover) {
      event.preventDefault();
      closeMenu(menu, true);
    } else if (event.key === "Tab") closeMenu(menu, false);
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  doc.addEventListener("click", function (event) {
    var item = event.target.closest && event.target.closest(".menu .menu__item");
    if (!item || item.getAttribute("aria-disabled") === "true") return;
    closeMenu(item.closest(".menu"), true);
  });

  window.addEventListener(
    "resize",
    function () {
      openMenus().forEach(placeMenu);
    },
    { passive: true }
  );

  /* A menu placed against its button would drift when whatever holds the
     button scrolls: close it instead. Only a scroll that actually moved the
     button counts. Scroll events arrive a frame late, so the scroll that
     brought the button into view can land just after Enter opened the menu;
     that one, a console following its output and the menu's own list leave
     it open. */
  doc.addEventListener(
    "scroll",
    function () {
      openMenus().forEach(function (menu) {
        var invoker = invokerFor(menu);
        if (!invoker || !menu.hasAttribute("data-placed")) return;
        var r = invoker.getBoundingClientRect();
        var at = (menu.qtAnchor || "").split(",");
        if (Math.abs(r.left - at[0]) > 1 || Math.abs(r.top - at[1]) > 1) closeMenu(menu, false);
      });
    },
    { passive: true, capture: true }
  );

  /* ── Tooltips: Escape hides an open tooltip without moving focus. ── */
  doc.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    doc.querySelectorAll(".tip").forEach(function (tip) {
      if (tip.matches(":hover") || tip.contains(doc.activeElement)) tip.setAttribute("data-tip-dismissed", "");
    });
  });

  function undismiss(event) {
    var tip = event.target.closest && event.target.closest(".tip");
    if (tip) tip.removeAttribute("data-tip-dismissed");
  }

  doc.addEventListener("focusout", undismiss);
  doc.addEventListener("pointerleave", undismiss, true);

  /* ── Top bar menu (a details element): close it on Escape, when a link
     is chosen, on a click outside, when focus moves on past it (so the
     open panel never covers the control that has focus), and when the
     screen grows past it. ── */
  function closeNavMenus(except) {
    doc.querySelectorAll(".nav__menu[open]").forEach(function (d) {
      if (d !== except) d.open = false;
    });
  }

  doc.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    var open = doc.querySelector(".nav__menu[open]");
    if (open) {
      open.open = false;
      var summary = open.querySelector("summary");
      if (summary) summary.focus();
    }
  });

  doc.addEventListener("click", function (event) {
    var inside = event.target.closest && event.target.closest(".nav__menu");
    if (!inside) closeNavMenus(null);
    else if (event.target.closest("a")) inside.open = false;
  });

  doc.addEventListener("focusout", function (event) {
    var menu = event.target.closest && event.target.closest(".nav__menu[open]");
    var next = event.relatedTarget;
    /* No relatedTarget: focus left the window, which is not moving on. */
    if (menu && next && !menu.contains(next)) menu.open = false;
  });

  if (window.matchMedia) {
    var wide = window.matchMedia("(min-width: 60rem)");
    var onWide = function () {
      if (wide.matches) closeNavMenus(null);
    };
    if (wide.addEventListener) wide.addEventListener("change", onWide);
  }

  /* ── Dialogs: <button data-dialog="#confirm-delete"> opens it modally.
     Buttons inside <form method="dialog"> close it with their value. ── */
  doc.addEventListener("click", function (event) {
    var opener = event.target.closest && event.target.closest("[data-dialog]");
    if (!opener) return;
    var dialog = doc.querySelector(opener.getAttribute("data-dialog"));
    if (dialog && dialog.showModal && !dialog.open) dialog.showModal();
  });

  /* ── Drop zones: mark the drag-over state. ── */
  doc.addEventListener("dragover", function (event) {
    var zone = event.target.closest && event.target.closest(".dropzone");
    if (zone) zone.setAttribute("data-dragover", "");
  });

  ["dragleave", "drop"].forEach(function (type) {
    doc.addEventListener(type, function (event) {
      var zone = event.target.closest && event.target.closest(".dropzone");
      if (zone) zone.removeAttribute("data-dragover");
    });
  });

  /* ── Scrolling regions must be reachable by keyboard and named. Each one
     is watched on its own (its size by a ResizeObserver, its content by
     the MutationObserver below), so a streaming console costs one check
     per frame for that console only. ── */
  var SCROLLERS = ".data-table-wrap, .code pre, .console, .truncate, .chips:not(.chips--wrap)";
  var dirty = new Set();
  var frame = 0;

  function checkScroller(el) {
    if (el.matches(".chips")) {
      syncChips(el);
      return;
    }
    var scrolls = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    if (el.matches(".truncate")) {
      /* A value cut short gets its full text as a title, kept in step with
         the text; a title the page wrote itself is never touched. */
      var owned = el.hasAttribute("data-qt-title");
      if (el.hasAttribute("title") && !owned) return;
      if (scrolls) {
        el.setAttribute("title", el.textContent.trim());
        el.setAttribute("data-qt-title", "");
      } else if (owned) {
        el.removeAttribute("title");
        el.removeAttribute("data-qt-title");
      }
      return;
    }
    if (scrolls && !el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "0");
      el.setAttribute("data-qt-tabindex", "");
      if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) {
        var name = el.getAttribute("data-label");
        if (!name) {
          var caption = el.querySelector("caption");
          var code = el.closest(".code");
          var bar = code && code.querySelector(".code__label");
          name = (caption && caption.textContent) || (bar && bar.textContent) || strings.scrollable;
        }
        el.setAttribute("aria-label", name.trim());
        if (!el.hasAttribute("role")) el.setAttribute("role", "region");
      }
    } else if (!scrolls && el.hasAttribute("data-qt-tabindex")) {
      el.removeAttribute("tabindex");
      el.removeAttribute("data-qt-tabindex");
    }
  }

  function schedule(el) {
    dirty.add(el);
    if (frame) return;
    frame = window.requestAnimationFrame(function () {
      frame = 0;
      var batch = Array.from(dirty);
      dirty.clear();
      batch.forEach(function (node) {
        if (node.isConnected) checkScroller(node);
      });
    });
  }

  var sizeObserver = window.ResizeObserver
    ? new ResizeObserver(function (entries) {
        entries.forEach(function (entry) {
          schedule(entry.target);
        });
      })
    : null;

  function each(scope, selector, fn) {
    if (scope.matches && scope.matches(selector)) fn(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(selector).forEach(fn);
  }

  /* Set up everything inside `scope` (the document at load; added markup
     later, automatically). */
  function init(scope) {
    scope = scope || doc;
    each(scope, TABLIST, function (list) {
      var key = syncKey(list);
      var stored = key && storedChoice(key);
      var chosen =
        (stored && tabByValue(list, stored)) ||
        list.querySelector('[role="tab"][aria-selected="true"]') ||
        list.querySelector('[role="tab"]');
      if (chosen) selectTab(chosen, false, true);
    });
    each(scope, SCROLLERS, function (el) {
      if (sizeObserver) sizeObserver.observe(el);
      schedule(el);
    });
    each(scope, '.walk__step[aria-current="step"]', chooseStep);
    if (scope === doc) {
      syncThemeControls();
      queueNav();
    }
  }

  var addedObserver = new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        init(node);
        filterAdded(node);
      });
      var host = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      var scroller = host && host.closest(SCROLLERS);
      if (scroller) schedule(scroller);
    });
  });

  /* ── Printing: every disclosure opens for paper, and closes again
     after. ── */
  window.addEventListener("beforeprint", function () {
    doc.querySelectorAll("details:not([open])").forEach(function (d) {
      d.setAttribute("data-qt-print-opened", "");
      d.open = true;
    });
  });

  window.addEventListener("afterprint", function () {
    doc.querySelectorAll("details[data-qt-print-opened]").forEach(function (d) {
      d.removeAttribute("data-qt-print-opened");
      d.open = false;
    });
  });

  function start() {
    ensureRegion();
    ensureQuiet();
    init(doc);
    /* In a frame: reading the body's colour now would force a whole style
       and layout pass inside this script's evaluation (88ms on the
       reference at 390). */
    window.requestAnimationFrame(syncThemeColor);
    busyObserver.observe(doc.body, {
      attributes: true,
      attributeFilter: ["aria-busy"],
      attributeOldValue: true,
      subtree: true,
    });
    addedObserver.observe(doc.body, { childList: true, characterData: true, subtree: true });
  }

  window.QT = {
    toast: toast,
    announce: announce,
    setTheme: setTheme,
    selectTab: selectTab,
    init: init,
    strings: strings,
  };

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();
})();
