// Feedback form URL (Tally). Set to '' to hide the popup's "Feedback" link.
const FEEDBACK_URL = 'https://tally.so/r/44yrQX';

export function hasEffectiveHeaders(headers = []) {
  return headers.some(header =>
    header?.enabled !== false && (header?.name || '').trim() !== ''
  );
}

export function getPopupUiState(config) {
  const effective = hasEffectiveHeaders(config?.headers || []);
  const enabled = !!config?.enabled;
  return {
    hasEffectiveHeaders: effective,
    actionsVisible: effective,
    enabled,
    paused: effective && !enabled
  };
}

export class PopupApp {
  constructor() {
    this.config = null; // single config
    this.$headers = document.getElementById('headers');
    this.$toggle = document.getElementById('toggleBtn');
    this.$add = document.getElementById('addHeaderBtn');
    this.$share = document.getElementById('shareBtn');
    this.$feedback = document.getElementById('feedbackLink');
    this._initialized = false;
    this._mutationRevision = 0;
    this._lastMutationPromise = Promise.resolve();
    this.ready = this.init();
  }

  async init() {
    await this.ensureConfig();
    this.render();
    this.bindEvents();
    this._initialized = true;
    this.updateControlsUI();
    if (FEEDBACK_URL && this.$feedback) {
      this.$feedback.href = FEEDBACK_URL;
      this.$feedback.hidden = false;
    }
  }

  async ensureConfig() {
    // Ask background first so getConfigs acts as a barrier behind any save from
    // a popup that was just closed. Direct storage reads can otherwise observe
    // the old value while the background is still processing that save.
    let list = [];
    let backgroundAvailable = false;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await chrome.runtime.sendMessage({ action: 'getConfigs' });
        if (res?.success) {
          list = res.data || [];
          backgroundAvailable = true;
          break;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 120));
    }

    // Storage is a fallback only when the background handshake failed.
    if (!backgroundAvailable) {
      try {
        const stored = await chrome.storage?.local?.get?.('configs');
        const maybe = stored?.configs || [];
        if (Array.isArray(maybe)) list = maybe;
      } catch (_) {}
    }

    if (list.length === 0) {
      try {
        const create = await chrome.runtime.sendMessage({
          action: 'addConfig',
          data: { name: 'Default', enabled: false, headers: [], scope: { type: 'all', value: '' } }
        });
        if (create?.success) {
          this.config = create.data;
          return;
        }
      } catch (_) {}
      this.config = { name: 'Default', enabled: false, headers: [], scope: { type: 'all', value: '' } };
    } else {
      this.config = list[0];
    }
  }

  render() {
    this.renderHeaders();
    this.updateControlsUI();
  }

  updateControlsUI() {
    const state = getPopupUiState(this.config);
    this.$toggle.hidden = !state.actionsVisible;
    this.$toggle.disabled = !state.actionsVisible;
    this.$share.hidden = !state.actionsVisible;
    this.$share.disabled = !state.actionsVisible;
    this.$toggle.setAttribute('data-enabled', state.enabled ? 'true' : 'false');
    this.$toggle.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    this.$toggle.innerHTML = state.enabled ? `
      <svg viewBox="0 0 24 24" class="vh-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>
      <span>Pause</span>
    ` : `
      <svg viewBox="0 0 24 24" class="vh-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
      <span>Resume</span>
    `;
    this.$add.disabled = !this._initialized || state.paused;
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
    const disabled = getPopupUiState(this.config).paused ? 'disabled' : '';
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
      this.persistCurrentState();
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
      this.persistCurrentState();
    });

    this.$toggle.addEventListener('click', async () => {
      if (!hasEffectiveHeaders(this.config?.headers || [])) return;
      const previousEnabled = !!this.config.enabled;
      const desiredEnabled = !previousEnabled;
      const revision = ++this._mutationRevision;
      this.config.enabled = desiredEnabled;
      this.render();

      const mutation = Promise.resolve(chrome.runtime.sendMessage({
        action: 'toggleConfig',
        data: { id: this.config.id, enabled: desiredEnabled }
      })).then((res) => {
        if (revision !== this._mutationRevision) return res;
        if (res?.success) {
          this.config.enabled = !!res.data?.enabled;
        } else {
          this.config.enabled = previousEnabled;
          console.warn(res?.error || 'Failed to toggle');
        }
        this.render();
        return res;
      }).catch((error) => {
        if (revision === this._mutationRevision) {
          this.config.enabled = previousEnabled;
          this.render();
        }
        console.warn(error?.message || 'Failed to toggle');
      });
      this._lastMutationPromise = mutation;
      await mutation;
    });

    this.$headers.addEventListener('input', (event) => {
      if (event.target.matches('.vh-h-name, .vh-h-value')) {
        this.persistCurrentState();
      }
    });
    this.$headers.addEventListener('change', (event) => {
      if (event.target.matches('.vh-h-enabled')) {
        this.persistCurrentState();
      }
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

  persistCurrentState() {
    this.syncFromDom();
    const previousEnabled = !!this.config.enabled;
    const headers = this.config.headers.map(header => ({ ...header }));
    const payload = { headers };
    if (!previousEnabled && hasEffectiveHeaders(headers)) {
      this.config.enabled = true;
      payload.enabled = true;
    }
    this.updateControlsUI();

    const revision = ++this._mutationRevision;
    const mutation = Promise.resolve(chrome.runtime.sendMessage({
      action: 'updateConfig',
      data: { id: this.config.id, config: payload }
    })).then((res) => {
      if (revision !== this._mutationRevision) return res;
      if (res?.success) {
        if (typeof res.data?.enabled === 'boolean') {
          this.config.enabled = res.data.enabled;
        }
      } else {
        if (payload.enabled === true) this.config.enabled = previousEnabled;
        console.warn(res?.error || 'Save failed');
      }
      this.updateControlsUI();
      return res;
    }).catch((error) => {
      if (revision === this._mutationRevision && payload.enabled === true) {
        this.config.enabled = previousEnabled;
        this.updateControlsUI();
      }
      console.warn(error?.message || 'Save failed');
    });
    this._lastMutationPromise = mutation;
    return mutation;
  }

  addRowAndFocus() {
    this.syncFromDom();
    const idx = this.config.headers.push({ name: '', value: '', type: 'request', enabled: true }) - 1;
    this._pendingFocusIndex = idx;
    this.renderHeaders();
    this.persistCurrentState();
  }
}
