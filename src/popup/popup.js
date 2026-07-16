// Popup - Multi URL-pattern tabs, each with its own header list (English UI)
import './popup.css';

// Feedback form URL (Tally). Set to '' to hide the popup's "Feedback" link.
const FEEDBACK_URL = 'https://tally.so/r/44yrQX';

class PopupApp {
  constructor() {
    // All URL-pattern tabs (each item is one Config)
    this.configs = [];
    // Currently selected tab's config id
    this.activeId = null;
    this.$tabs = document.getElementById('tabs');
    this.$headers = document.getElementById('headers');
    this._tabFormMode = null; // null | 'add' | 'edit'
    this.$tabFormHost = this.ensureTabFormHost();
    this.$toggle = document.getElementById('toggleBtn');
    this.$add = document.getElementById('addHeaderBtn');
    this.$share = document.getElementById('shareBtn');
    this.$feedback = document.getElementById('feedbackLink');
    this._saveTimer = null;
    this.init();
  }

  /** Active tab config (headers + URL regex live here). */
  get config() {
    return this.configs.find(c => c.id === this.activeId) || this.configs[0] || null;
  }

  /** Global Pause/Resume flag — kept in sync across every tab. */
  get globallyEnabled() {
    return this.configs.some(c => !!c.enabled);
  }

  async init() {
    await this.ensureConfigs();
    this.render();
    this.bindEvents();
    // Rebuild session rules against the current tab address whenever the popup opens
    try {
      await chrome.runtime.sendMessage({ action: 'refreshRules' });
    } catch (_) {}
    if (FEEDBACK_URL && this.$feedback) {
      this.$feedback.href = FEEDBACK_URL;
      this.$feedback.hidden = false;
    }
  }

  async ensureConfigs() {
    // 1) Fast path: read from storage directly (avoids first-wake race)
    try {
      const stored = await chrome.storage?.local?.get?.('configs');
      const maybe = stored?.configs || [];
      if (Array.isArray(maybe) && maybe.length > 0) {
        this.configs = maybe;
        this.activeId = maybe[0].id;
        return;
      }
    } catch (_) {}

    // 2) Ask background (with small retry to tolerate first SW wake latency)
    let list = [];
    for (let i = 0; i < 3; i++) {
      try {
        const res = await chrome.runtime.sendMessage({ action: 'getConfigs' });
        list = res?.data || [];
        if (list.length > 0) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 120));
    }

    if (list.length === 0) {
      const create = await chrome.runtime.sendMessage({
        action: 'addConfig',
        data: { name: '*', enabled: false, headers: [], scope: { type: 'all', value: '' } }
      });
      if (create?.success) {
        this.configs = [create.data];
      } else {
        this.configs = [{ id: 'local_default', name: '*', enabled: false, headers: [], scope: { type: 'all', value: '' } }];
      }
    } else {
      this.configs = list;
    }
    this.activeId = this.configs[0].id;
  }

  render() {
    this.renderTabs();
    this.updateToggleUI();
    this.renderHeaders();
    // Treat "no active headers yet" as Ready state (not paused)
    const hasActive = this.hasAnyActiveHeaders();
    const pausedExplicit = !this.globallyEnabled && hasActive;
    if (pausedExplicit) this.$add.setAttribute('disabled', 'disabled');
    else this.$add.removeAttribute('disabled');
  }

  /** True if any tab has at least one enabled, non-empty header name. */
  hasAnyActiveHeaders() {
    return this.configs.some(c =>
      (c?.headers || []).some(h => (h?.enabled !== false) && (h?.name || '').trim())
    );
  }

  hasActiveHeadersInConfig(config) {
    return (config?.headers || []).some(h => (h?.enabled !== false) && (h?.name || '').trim());
  }

  /**
   * URL pattern string for a config.
   * Empty / type "all" / literal "*" all mean match every tab.
   */
  getPatternLabel(config) {
    const scope = config?.scope || {};
    if (!scope.type || scope.type === 'all') return '*';
    if (scope.type === 'regex') {
      const v = (scope.value || '').trim();
      return (!v || v === '*') ? '*' : v;
    }
    if (scope.type === 'domain') return scope.value || '*';
    if (scope.type === 'url_prefix' || scope.type === 'prefix') {
      return scope.value ? `${scope.value}*` : '*';
    }
    return (scope.value || '').trim() || '*';
  }

  /**
   * Optional display alias (config.name). Empty means "no alias".
   * Legacy configs often stored the pattern in name — treat that as no alias.
   */
  getAlias(config) {
    const alias = (config?.name || '').trim();
    if (!alias) return '';
    const pattern = this.getPatternLabel(config);
    if (alias === pattern) return '';
    return alias;
  }

  /** Tab chip text: prefer alias, fall back to URL pattern. */
  getTabLabel(config) {
    return this.getAlias(config) || this.getPatternLabel(config);
  }

  /**
   * Convert a user-entered pattern into a stored scope.
   * Blank or "*" => match all URLs; otherwise treat as a regex for the tab address.
   */
  patternToScope(pattern) {
    const p = (pattern == null ? '' : String(pattern)).trim();
    if (!p || p === '*') {
      return { type: 'all', value: '' };
    }
    return { type: 'regex', value: p };
  }

  renderTabs() {
    const tabsHtml = this.configs.map(c => {
      const label = this.getTabLabel(c);
      const pattern = this.getPatternLabel(c);
      const alias = this.getAlias(c);
      const selected = c.id === this.activeId;
      const canClose = this.configs.length > 1;
      const tip = alias
        ? `${alias}\n${pattern}\nClick again to edit alias & regex`
        : `${pattern}\nClick again to edit alias & regex`;
      return `
        <button type="button" class="vh-tab${alias ? ' vh-tab--alias' : ''}" role="tab" data-id="${this.escape(c.id)}"
          aria-selected="${selected ? 'true' : 'false'}" title="${this.escape(tip)}">
          <span class="vh-tab-label">${this.escape(label)}</span>
          ${canClose ? `
            <span class="vh-tab-close" data-close-id="${this.escape(c.id)}" title="Remove tab" aria-label="Remove tab">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
              </svg>
            </span>
          ` : ''}
        </button>
      `;
    }).join('');

    this.$tabs.innerHTML = `
      ${tabsHtml}
      <button type="button" id="addTabBtn" class="vh-tab-add" title="Add URL pattern tab" aria-label="Add URL pattern tab">+</button>
    `;
    this.bindTabEvents();
  }

  /**
   * Ensure the form host row exists under the tab chips.
   * Created at runtime so a stale popup.html without #tabFormHost still works.
   */
  ensureTabFormHost() {
    let host = document.getElementById('tabFormHost');
    if (host) return host;
    if (!this.$tabs) return null;
    host = document.createElement('div');
    host.id = 'tabFormHost';
    host.className = 'vh-tab-form-host';
    host.hidden = true;
    this.$tabs.insertAdjacentElement('afterend', host);
    return host;
  }

  /** Hide the add/edit form row under the tab chips. */
  hideTabForm() {
    this._tabFormMode = null;
    this.$tabFormHost = this.ensureTabFormHost();
    if (this.$tabFormHost) {
      this.$tabFormHost.hidden = true;
      this.$tabFormHost.innerHTML = '';
    }
    this.$tabs?.classList.remove('vh-tabs--editing');
  }

  bindTabEvents() {
    this.$tabs.querySelectorAll('.vh-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // Close button handles its own click
        if (e.target.closest('.vh-tab-close')) return;
        const id = btn.dataset.id;
        if (!id) return;
        // Clicking the active tab edits alias + regex; otherwise switch tabs
        if (id === this.activeId) {
          this.beginEditTab(id);
          return;
        }
        this.syncFromDom();
        this.hideTabForm();
        this.activeId = id;
        this.render();
      });
    });

    this.$tabs.querySelectorAll('.vh-tab-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeTab(btn.dataset.closeId);
      });
    });

    const addBtn = document.getElementById('addTabBtn');
    addBtn?.addEventListener('click', () => this.addTab());
  }

  /**
   * Show alias + regex inputs on a new row under the tabs, with ✓ / ✕ actions.
   * Used for both "add tab" and "edit active tab".
   */
  showTabForm({ alias = '', pattern = '', onSubmit, onCancel }) {
    this.$tabFormHost = this.ensureTabFormHost();
    if (!this.$tabFormHost) {
      console.warn('tabFormHost missing; cannot show tab form');
      this._tabFormMode = null;
      return;
    }

    this.$tabFormHost.innerHTML = `
      <div class="vh-tab-form">
        <input type="text" class="vh-tab-edit vh-tab-alias" placeholder="Alias (optional)" aria-label="Tab alias" />
        <input type="text" class="vh-tab-edit vh-tab-pattern" placeholder="URL regex (* = all)" aria-label="Browser tab URL regex" />
        <div class="vh-tab-form-actions">
          <button type="button" class="vh-tab-form-btn vh-tab-form-ok" title="Confirm" aria-label="Confirm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
          </button>
          <button type="button" class="vh-tab-form-btn vh-tab-form-cancel" title="Cancel" aria-label="Cancel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6 L18 18 M18 6 L6 18"/>
            </svg>
          </button>
        </div>
      </div>
    `;
    this.$tabFormHost.hidden = false;
    this.$tabs.classList.add('vh-tabs--editing');

    const form = this.$tabFormHost.querySelector('.vh-tab-form');
    const aliasInput = form.querySelector('.vh-tab-alias');
    const patternInput = form.querySelector('.vh-tab-pattern');
    const okBtn = form.querySelector('.vh-tab-form-ok');
    const cancelBtn = form.querySelector('.vh-tab-form-cancel');
    aliasInput.value = alias;
    patternInput.value = pattern === '*' ? '' : pattern;

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        onSubmit({
          alias: (aliasInput.value || '').trim(),
          pattern: patternInput.value
        });
      } else {
        onCancel?.();
      }
    };

    okBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });

    aliasInput.focus();
    if (alias) aliasInput.select();
  }

  /**
   * Create a new URL-pattern tab.
   * Shows alias + regex inputs under the tab row (empty regex => "*" = all tabs).
   */
  addTab() {
    this.syncFromDom();
    // Already showing the add form — just focus it
    if (this._tabFormMode === 'add' && this.$tabFormHost && !this.$tabFormHost.hidden) {
      this.$tabFormHost.querySelector('.vh-tab-alias')?.focus();
      return;
    }
    this._tabFormMode = 'add';

    this.showTabForm({
      alias: '',
      pattern: '',
      onSubmit: async ({ alias, pattern }) => {
        const scope = this.patternToScope(pattern);
        const res = await chrome.runtime.sendMessage({
          action: 'addConfig',
          data: {
            name: alias, // optional display alias; empty = show pattern on the chip
            enabled: this.globallyEnabled,
            headers: [],
            scope
          }
        });
        if (!res?.success) {
          console.warn(res?.error || 'Failed to add tab');
          this.hideTabForm();
          return;
        }
        this.configs.push(res.data);
        this.activeId = res.data.id;
        this.hideTabForm();
        this.render();
      },
      onCancel: () => this.hideTabForm()
    });
  }

  /** Edit alias + URL regex for an existing tab (form on the row below chips). */
  beginEditTab(id) {
    const config = this.configs.find(c => c.id === id);
    if (!config) return;
    // Already editing this tab — just focus the form
    if (
      this._tabFormMode === 'edit' &&
      this.activeId === id &&
      this.$tabFormHost &&
      !this.$tabFormHost.hidden
    ) {
      this.$tabFormHost.querySelector('.vh-tab-alias')?.focus();
      return;
    }
    this._tabFormMode = 'edit';

    this.showTabForm({
      alias: this.getAlias(config),
      pattern: this.getPatternLabel(config),
      onSubmit: async ({ alias, pattern }) => {
        const scope = this.patternToScope(pattern);
        const res = await chrome.runtime.sendMessage({
          action: 'updateConfig',
          data: { id, config: { scope, name: alias } }
        });
        if (res?.success) {
          const idx = this.configs.findIndex(c => c.id === id);
          if (idx >= 0) this.configs[idx] = { ...this.configs[idx], ...res.data };
        } else {
          console.warn(res?.error || 'Failed to update tab');
        }
        this.hideTabForm();
        this.renderTabs();
      },
      onCancel: () => this.hideTabForm()
    });
  }

  async removeTab(id) {
    if (this.configs.length <= 1) return;
    this.syncFromDom();
    this.hideTabForm();

    const res = await chrome.runtime.sendMessage({ action: 'deleteConfig', data: { id } });
    if (!res?.success) {
      console.warn(res?.error || 'Failed to delete tab');
      return;
    }

    this.configs = (res.data && res.data.length) ? res.data : this.configs.filter(c => c.id !== id);
    if (this.activeId === id) {
      this.activeId = this.configs[0]?.id || null;
    }
    this.render();
  }

  updateToggleUI() {
    const hasActive = this.hasAnyActiveHeaders();
    // UI shows enabled when there are no active headers yet ("Ready" state)
    const uiEnabled = this.globallyEnabled || !hasActive;
    this.$toggle.setAttribute('data-enabled', uiEnabled ? 'true' : 'false');
    this.$toggle.innerHTML = uiEnabled ? `
      <svg viewBox="0 0 24 24" class="vh-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>
      <span>Pause</span>
    ` : `
      <svg viewBox="0 0 24 24" class="vh-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
      <span>Resume</span>
    `;
  }

  renderHeaders() {
    const config = this.config;
    if (!config) return;

    // if there are no headers, add one empty row and focus it
    if (!config.headers || config.headers.length === 0) {
      config.headers = [{ name: '', value: '', type: 'request', enabled: true }];
      this._pendingFocusIndex = 0;
    }
    const rows = config.headers.map((h, i) => this.headerRow(h, i)).join('');
    this.$headers.innerHTML = rows;
    this.bindHeaderRowEvents();
    if (this._pendingFocusIndex !== undefined) {
      const idx = this._pendingFocusIndex;
      delete this._pendingFocusIndex;
      setTimeout(() => {
        const row = this.$headers.querySelector(`.vh-header-row[data-index="${idx}"] .vh-h-name`);
        row && row.focus();
      }, 0);
    }
  }

  headerRow(h, i) {
    // Only disable when user explicitly paused while there are active headers
    const hasActive = this.hasAnyActiveHeaders();
    const pausedExplicit = !this.globallyEnabled && hasActive;
    const disabled = pausedExplicit ? 'disabled' : '';
    return `
      <div class="vh-header-row" data-index="${i}">
        <input type="checkbox" class="vh-h-enabled" ${h.enabled !== false ? 'checked' : ''} aria-label="Toggle header" ${disabled} />
        <input class="vh-input vh-h-name" placeholder="Name" value="${this.escape(h.name)}" ${disabled} />
        <input class="vh-input vh-h-value" placeholder="Value" value="${this.escape(h.value)}" ${disabled} />
        <button class="vh-del vh-del-header" aria-label="Delete header" title="Delete" ${disabled}>
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    `;
  }

  bindHeaderRowEvents() {
    this.$headers.querySelectorAll('.vh-del-header').forEach(btn => btn.addEventListener('click', (e) => {
      const row = e.target.closest('.vh-header-row');
      const idx = parseInt(row.dataset.index, 10);
      this.syncFromDom();
      this.config.headers.splice(idx, 1);
      this.renderHeaders();
      this.scheduleSave();
    }));

    // Enter behavior
    this.$headers.querySelectorAll('.vh-h-name').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const row = e.target.closest('.vh-header-row');
          row?.querySelector('.vh-h-value')?.focus();
        }
      });
    });

    this.$headers.querySelectorAll('.vh-h-value').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.addRowAndFocus();
        }
      });
    });
  }

  bindEvents() {
    this.$add.addEventListener('click', () => {
      this.syncFromDom();
      const idx = this.config.headers.push({ name: '', value: '', type: 'request', enabled: true }) - 1;
      this._pendingFocusIndex = idx;
      this.renderHeaders();
      this.scheduleSave();
    });

    this.$toggle.addEventListener('click', async () => {
      // Decide direction from what the button actually shows (uiEnabled), not the
      // raw config.enabled — in the "Ready" state (no active headers yet) the two
      // diverge, which otherwise makes the first click a silent no-op and forces a
      // second click. "Pause" shown => turn off; "Resume" shown => turn on.
      const hasActive = this.hasAnyActiveHeaders();
      const uiEnabled = this.globallyEnabled || !hasActive;
      const desiredEnabled = !uiEnabled;
      if (desiredEnabled === this.globallyEnabled && hasActive) return;

      // When enabling, request host permission for all URLs (optional-perms builds).
      if (desiredEnabled && chrome.permissions && chrome.permissions.request) {
        try {
          const granted = await new Promise(resolve => {
            chrome.permissions.request({ origins: ['*://*/*'] }, (ok) => resolve(!!ok));
          });
          if (!granted) { console.warn('Permission required to enable'); return; }
        } catch (_) {
          // ignore; proceed
        }
      }
      const res = await chrome.runtime.sendMessage({
        action: 'setGlobalEnabled',
        data: { enabled: desiredEnabled }
      });
      if (res?.success) {
        const list = res.data || [];
        if (list.length) {
          this.configs = list;
          if (!this.configs.find(c => c.id === this.activeId)) {
            this.activeId = this.configs[0].id;
          }
        } else {
          this.configs.forEach(c => { c.enabled = desiredEnabled; });
        }
        this.render();
      } else { console.warn(res?.error || 'Failed to toggle'); }
    });

    // auto-save on input (debounced)
    this.$headers.addEventListener('input', () => { this.scheduleSave(); });
    this.$headers.addEventListener('change', () => {
      this.scheduleSave();
    });

    // Share: copy fragment URL with KV-only JSON (enabled rows of the active tab)
    this.$share.addEventListener('click', async () => {
      this.syncFromDom();
      const enabled = (this.config.headers || []).filter(h => h.enabled !== false && (h.name || '').trim());
      // Minimal schema: top-level KV, no version field; all keys are headers
      const obj = {};
      enabled.forEach(h => { obj[h.name] = h.value; });
      const payload = encodeURIComponent(JSON.stringify(obj));
      const url = `https://vibeheader.com/s#c=${payload}`;
      try {
        await navigator.clipboard.writeText(url);
        const old = this.$share.innerHTML;
        this.$share.innerHTML = '<svg viewBox="0 0 24 24" class="vh-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><span>Copied!</span>';
        setTimeout(() => { this.$share.innerHTML = old; }, 1200);
      } catch (e) {
        console.warn('Clipboard failed, printing to console');
        console.log('Share URL:', url);
      }
    });
  }

  // sync the current DOM inputs back into the in-memory model so a re-render doesn't lose typed content
  syncFromDom() {
    const config = this.config;
    if (!config) return;
    const rows = Array.from(this.$headers.querySelectorAll('.vh-header-row'));
    if (!rows.length) return;
    const next = rows.map(row => ({
      type: 'request',
      name: row.querySelector('.vh-h-name')?.value?.trim() || '',
      value: row.querySelector('.vh-h-value')?.value?.trim() || '',
      enabled: !!row.querySelector('.vh-h-enabled')?.checked
    }));
    config.headers = next;
  }

  escape(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      this.syncFromDom();
      const config = this.config;
      if (!config) return;

      const hasActive = this.hasActiveHeadersInConfig(config);
      const payload = { headers: config.headers };
      // auto-enable when first meaningful input exists (and request host permission once)
      if (!this.globallyEnabled && hasActive) {
        const granted = await this.requestAllSitesPermission();
        if (granted) {
          const en = await chrome.runtime.sendMessage({
            action: 'setGlobalEnabled',
            data: { enabled: true }
          });
          if (en?.success && Array.isArray(en.data) && en.data.length) {
            this.configs = en.data;
            if (!this.configs.find(c => c.id === this.activeId)) {
              this.activeId = this.configs[0].id;
            }
          } else {
            this.configs.forEach(c => { c.enabled = true; });
          }
        } else {
          // keep paused if user denied permission
          this.updateToggleUI();
        }
      }
      const res = await chrome.runtime.sendMessage({
        action: 'updateConfig',
        data: { id: config.id, config: payload }
      });
      if (res?.success) {
        // merge new state silently without re-rendering rows to keep focus
        const wasEnabled = this.globallyEnabled;
        const idx = this.configs.findIndex(c => c.id === config.id);
        if (idx >= 0) this.configs[idx] = { ...this.configs[idx], ...res.data };
        if (this.globallyEnabled !== wasEnabled) {
          this.updateToggleUI();
          // re-render to toggle disabled states
          this.renderHeaders();
          if (!this.globallyEnabled) this.$add.setAttribute('disabled', 'disabled');
          else this.$add.removeAttribute('disabled');
        }
      } else {
        console.warn(res?.error || 'Save failed');
      }
    }, 400);
  }

  async requestAllSitesPermission() {
    if (!chrome.permissions || !chrome.permissions.request) return true;
    return await new Promise(resolve => {
      chrome.permissions.request({ origins: ['*://*/*'] }, ok => resolve(!!ok));
    });
  }

  addRowAndFocus() {
    this.syncFromDom();
    const idx = this.config.headers.push({ name: '', value: '', type: 'request', enabled: true }) - 1;
    this._pendingFocusIndex = idx;
    this.renderHeaders();
    this.scheduleSave();
  }
}

document.addEventListener('DOMContentLoaded', () => new PopupApp());
