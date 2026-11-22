// All In One NR2003 — tiny helpers shared by the tool windows: tabs, segmented controls, choice cards, toasts.
// Pages mark up  <nav class="tabs"><button class="tab" data-tab="x">…</button></nav>  and  <section class="tabpanel" data-panel="x">…</section>.
(function () {
  'use strict';
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private window / blocked: the page works without it */ } },
  };
  const tabKey = 'ui-tab:' + (location.pathname || '').split('/').pop();

  function showTab(name) {
    const tabs = [...document.querySelectorAll('.tabs .tab[data-tab]')], panels = [...document.querySelectorAll('.tabpanel[data-panel]')];
    if (!tabs.some(t => t.dataset.tab === name)) name = tabs[0] && tabs[0].dataset.tab;
    tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'));
    panels.forEach(p => p.classList.toggle('on', p.dataset.panel === name));
    store.set(tabKey, name);
    document.body.dataset.tab = name;
    window.scrollTo(0, 0);
  }

  function initTabs() {
    const tabs = document.querySelectorAll('.tabs .tab[data-tab]');
    if (!tabs.length) return;
    tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
    document.addEventListener('click', (e) => { const g = e.target.closest && e.target.closest('[data-goto]'); if (g) { e.preventDefault(); showTab(g.dataset.goto); } });
    showTab(store.get(tabKey) || tabs[0].dataset.tab);
  }

  // segmented control: buttons carry data-v; value is shown with .on; onChange(v) when one is clicked
  function seg(el, value, onChange) {
    const paint = (v) => el.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('on', String(b.dataset.v) === String(v)));
    paint(value);
    if (!el.__segBound) {
      el.__segBound = true;
      el.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b || b.disabled) return; paint(b.dataset.v); if (el.__segCb) el.__segCb(b.dataset.v); });
    }
    if (onChange) el.__segCb = onChange;
    return paint;
  }

  // choice cards (radio-like): children .choice[data-v]
  function choices(el, value, onChange) {
    const paint = (v) => el.querySelectorAll('.choice[data-v]').forEach(c => c.classList.toggle('on', String(c.dataset.v) === String(v)));
    paint(value);
    if (!el.__chBound) {
      el.__chBound = true;
      el.addEventListener('click', (e) => { const c = e.target.closest('.choice[data-v]'); if (!c) return; paint(c.dataset.v); if (el.__chCb) el.__chCb(c.dataset.v); });
    }
    if (onChange) el.__chCb = onChange;
    return paint;
  }

  let toastEl = null, toastTimer = 0;
  function toast(text, ms) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = text; toastEl.style.display = '';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, ms || 2200);
  }

  window.ui = { showTab, seg, choices, toast, store };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTabs); else initTabs();
})();
