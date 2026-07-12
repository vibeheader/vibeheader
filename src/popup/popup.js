// Popup - Simple single-config editor (English UI)
import './popup.css';

// Feedback form URL (Tally). Set to '' to hide the popup's "Feedback" link.
const FEEDBACK_URL = 'https://tally.so/r/44yrQX';

class PopupApp {
  constructor() {
    this.config = null; // single config
    this.$headers = document.getElementById('headers');
    this.$toggle = document.getElementById('toggleBtn');
    this.$add = document.getElementById('addHeaderBtn');
    this.$share = document.getElementById('shareBtn');
    this.$feedback = document.getElementById('feedbackLink');
    this._saveTimer = null;
    this.init();
  }

  async init() {
    await this.ensureConfig();
    this.render();
    this.bindEvents();
    if (FEEDBACK_URL && this.$feedback) {
      this.$feedback.href = FEEDBACK_URL;
      this.$feedback.hidden = false;
    }
  }

  async ensureConfig() {
    // 1) Try fast path: read from storage directly (avoids first-wake race)
    try {
      const stored = await chrome.storage?.local?.get?.('configs');
      const maybe = stored?.configs || [];
      if (Array.isArray(maybe) && maybe.length > 0) {
        this.config = maybe[0];
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
      // backoff 120ms
      await new Promise(r => setTimeout(r, 120));
    }

    if (list.length === 0) {
      const create = await chrome.runtime.sendMessage({
        action: 'addConfig',
        data: { name: 'Default', enabled: false, headers: [], scope: { type: 'all', value: '' } }
      });
      if (create?.success) this.config = create.data; else this.config = { name: 'Default', enabled: false, headers: [], scope: { type: 'all', value: '' } };
    } else {
      this.config = list[0];
    }
  }

  render() {
    this.updateToggleUI();
    this.renderHeaders();
    // Treat "no active headers yet" as Ready state (not paused)
    const hasActive = (this.config?.headers || []).some(h => (h?.enabled !== false) && (h?.name || '').trim());
    const pausedExplicit = !this.config?.enabled && hasActive; // only disable when explicitly paused with active headers
    if (pausedExplicit) this.$add.setAttribute('disabled', 'disabled');
    else this.$add.removeAttribute('disabled');
  }

  updateToggleUI() {
    const hasActive = (this.config?.headers || []).some(h => (h?.enabled !== false) && (h?.name || '').trim());
    // UI shows enabled when there are no active headers yet ("Ready" state)
    const uiEnabled = this.config?.enabled || !hasActive;
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
    // if there are no headers, add one empty row and focus it
    if (!this.config.headers || this.config.headers.length === 0) {
      this.config.headers = [{ name: '', value: '', type: 'request', enabled: true }];
      this._pendingFocusIndex = 0;
    }
    const rows = this.config.headers.map((h, i) => this.headerRow(h, i)).join('');
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
    const hasActive = (this.config?.headers || []).some(x => (x?.enabled !== false) && (x?.name || '').trim());
    const pausedExplicit = !this.config?.enabled && hasActive;
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
      const hasActive = (this.config?.headers || []).some(h => (h?.enabled !== false) && (h?.name || '').trim());
      const uiEnabled = this.config?.enabled || !hasActive;
      const desiredEnabled = !uiEnabled;
      if (desiredEnabled === !!this.config.enabled) return; // already in target state

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
      const res = await chrome.runtime.sendMessage({ action: 'toggleConfig', data: { id: this.config.id, enabled: desiredEnabled } });
      if (res?.success) {
        this.config.enabled = desiredEnabled;
        this.render();
      } else { console.warn(res?.error || 'Failed to toggle'); }
    });

    // auto-save on input (debounced)
    this.$headers.addEventListener('input', () => { this.scheduleSave(); });
    this.$headers.addEventListener('change', () => {
      this.scheduleSave();
    });

    // Share: copy fragment URL with KV-only JSON (enabled rows only)
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
    const rows = Array.from(this.$headers.querySelectorAll('.vh-header-row'));
    if (!rows.length) return;
    const next = rows.map(row => ({
      type: 'request',
      name: row.querySelector('.vh-h-name')?.value?.trim() || '',
      value: row.querySelector('.vh-h-value')?.value?.trim() || '',
      enabled: !!row.querySelector('.vh-h-enabled')?.checked
    }));
    this.config.headers = next;
  }

  escape(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      this.syncFromDom();
      const hasActive = this.config.headers.some(h => (h.enabled !== false) && (h.name || '').trim());
      const payload = { headers: this.config.headers };
      // auto-enable when first meaningful input exists (and request host permission once)
      if (!this.config.enabled && hasActive) {
        const granted = await this.requestAllSitesPermission();
        if (granted) {
          payload.enabled = true;
        } else {
          // keep paused if user denied permission
          this.updateToggleUI();
        }
      }
      const res = await chrome.runtime.sendMessage({ action: 'updateConfig', data: { id: this.config.id, config: payload } });
      if (res?.success) {
        // merge new state silently without re-rendering rows to keep focus
        const wasEnabled = this.config.enabled;
        this.config = { ...this.config, ...res.data };
        if (this.config.enabled !== wasEnabled) {
          this.updateToggleUI();
          // re-render to toggle disabled states
          this.renderHeaders();
          if (!this.config.enabled) this.$add.setAttribute('disabled','disabled'); else this.$add.removeAttribute('disabled');
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
