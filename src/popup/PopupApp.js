import { Config } from '../shared/models/Config.js';
import {
  normalizeRequestMatch,
  RequestFilterLimits,
  serializedUtf8Size,
  requestMatchMatchesUrl
} from '../shared/utils/requestFilters.js';
import { ValidationUtils } from '../shared/utils/validation.js';

const FEEDBACK_URL = 'https://tally.so/r/44yrQX';
const SHARE_URL = 'https://vibeheader.com/s#c=';

const ICON = {
  pause: '<svg viewBox="0 0 24 24" class="vh-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" class="vh-icon" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13.8 10.2a4 4 0 010 5.6l-3 3a4 4 0 11-5.6-5.6l1.2-1.2"/><path d="M10.2 13.8a4 4 0 010-5.6l3-3a4 4 0 115.6 5.6l-1.2 1.2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  copyCheck: '<svg viewBox="0 0 24 24" class="vh-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  cross: '<svg viewBox="0 0 24 24" class="vh-icon" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12"/></svg>'
};

export function hasEffectiveHeaders(headers = []) {
  return headers.some(header =>
    header?.enabled !== false
    && !ValidationUtils.validateHeaderName(header?.name).length
    && !ValidationUtils.validateHeaderValue(header?.value).length
  );
}

export function getPopupUiState(config) {
  const effective = hasEffectiveHeaders(config?.headers || []);
  const enabled = typeof config?.active === 'boolean'
    ? config.active
    : !!config?.enabled;
  return {
    hasEffectiveHeaders: effective,
    actionsVisible: effective,
    enabled,
    paused: effective && !enabled
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function headerCount(profile) {
  return profile.headers.filter(header =>
    !ValidationUtils.validateHeaderName(header?.name).length
    && !ValidationUtils.validateHeaderValue(header?.value).length
  ).length;
}

function selectorValue(value) {
  return String(value || '').replace(/["\\]/g, '\\$&');
}

function requestScope(profile) {
  const entered = (profile?.filters || []).filter(filter =>
    String(filter.expression || '').trim()
  );
  if (!entered.length) return { all: true, filters: [] };
  return {
    all: false,
    filters: entered.filter(filter =>
      filter.enabled !== false && normalizeRequestMatch(filter).validation.valid
    )
  };
}

function representativeUrl(filter) {
  const normalized = normalizeRequestMatch(filter);
  const expression = String(normalized.expression || '').trim();
  switch (normalized.effectiveType) {
  case 'exactHost':
    return `https://${expression.replace(/\.$/, '')}/`;
  case 'hostWildcard':
    return `https://${expression.replace(/\*/g, 'overlap').replace(/\.$/, '')}/`;
  case 'exactUrl':
    return expression;
  case 'urlWildcard':
    return expression.replace(/\*/g, 'overlap');
  default:
    return null;
  }
}

function filtersOverlap(left, right) {
  const leftMatch = normalizeRequestMatch(left);
  const rightMatch = normalizeRequestMatch(right);
  if (leftMatch.effectiveType === rightMatch.effectiveType
    && String(leftMatch.expression).trim() === String(rightMatch.expression).trim()) {
    return true;
  }
  // Conflict hints are best-effort. Never execute user-provided Regex on the
  // Popup main thread merely to decide whether to show a warning.
  if (leftMatch.effectiveType === 'regex'
    || rightMatch.effectiveType === 'regex') {
    return false;
  }
  return [representativeUrl(leftMatch), representativeUrl(rightMatch)]
    .filter(Boolean)
    .some(url =>
      requestMatchMatchesUrl(leftMatch, url)
      && requestMatchMatchesUrl(rightMatch, url)
    );
}

function profileScopesOverlap(left, right) {
  const leftScope = requestScope(left);
  const rightScope = requestScope(right);
  if (leftScope.all || rightScope.all) {
    return (leftScope.all || leftScope.filters.length > 0)
      && (rightScope.all || rightScope.filters.length > 0);
  }
  return leftScope.filters.some(leftFilter =>
    rightScope.filters.some(rightFilter =>
      filtersOverlap(leftFilter, rightFilter)
    )
  );
}

export function findOverridingProfile(profiles, profileId, header) {
  const currentIndex = profiles.findIndex(profile => profile.id === profileId);
  if (currentIndex < 0
    || profiles[currentIndex].active !== true
    || header?.enabled === false
    || !String(header?.name || '').trim()) return null;

  const name = String(header.name).trim().toLowerCase();
  const type = header.type === 'response' ? 'response' : 'request';
  for (let index = profiles.length - 1; index > currentIndex; index -= 1) {
    const candidate = profiles[index];
    if (candidate.active !== true || !profileScopesOverlap(profiles[currentIndex], candidate)) {
      continue;
    }
    const conflicts = candidate.headers.some(candidateHeader =>
      candidateHeader.enabled !== false
      && String(candidateHeader.name || '').trim().toLowerCase() === name
      && (candidateHeader.type === 'response' ? 'response' : 'request') === type
      && String(candidateHeader.value ?? '') !== String(header.value ?? '')
    );
    if (conflicts) return candidate;
  }
  return null;
}

export class PopupApp {
  constructor() {
    this.profiles = [];
    this.selectedProfileId = '';
    this.profileModeActivated = false;
    this.config = null;
    this.currentTabUrl = '';
    this.currentTabHost = '';
    this.currentTabRoot = '';

    this.filtersOpen = false;
    this.testerOpen = false;
    this.testValue = '';
    this.testSubmitted = false;
    this.testPending = false;
    this.testError = '';
    this.testMatchedFilterIds = new Set();
    this.menuOpen = false;
    this.rowMenuId = null;
    this.renamingId = null;
    this.renameLocation = null;
    this.renameDraft = '';
    this.touchedFilters = new Set();

    this._initialized = false;
    this._profileRevisions = new Map();
    this._lastMutationPromise = Promise.resolve();
    this._pendingHeaderFocus = null;
    this._pendingFilterFocus = null;
    this._filterTestWorker = null;
    this._filterTestTimer = null;
    this._filterTestRunId = 0;

    this.cacheElements();
    this.ready = this.init();
  }

  cacheElements() {
    this.$app = document.getElementById('app');
    this.$popup = document.getElementById('popup') || this.$app;
    this.$profileTrigger = document.getElementById('profileTrigger');
    this.$profileName = document.getElementById('profileName');
    this.$profileContext = document.getElementById('profileContext');
    this.$profileRename = document.getElementById('profileRename');
    this.$profileRenameInput = document.getElementById('profileRenameInput');
    this.$profileRenameSave = document.getElementById('profileRenameSave');
    this.$toggle = document.getElementById('toggleBtn');
    this.$share = document.getElementById('shareBtn');
    this.$banner = document.getElementById('pauseBanner');
    this.$bannerText = document.getElementById('pauseBannerText');
    this.$headers = document.getElementById('headers');
    this.$filtersSection = document.getElementById('filtersSection');
    this.$filtersSummary = document.getElementById('filtersSummary');
    this.$filtersPanel = document.getElementById('filtersPanel');
    this.$filters = document.getElementById('filters');
    this.$testUrl = document.getElementById('testUrlBtn');
    this.$tester = document.getElementById('urlTester');
    this.$testerInput = document.getElementById('urlTesterInput');
    this.$testerRun = document.getElementById('urlTesterRun');
    this.$testerResult = document.getElementById('urlTesterResult');
    this.$testerDone = document.getElementById('urlTesterDone');
    this.$addHeader = document.getElementById('addHeaderBtn');
    this.$addFilter = document.getElementById('addFilterBtn');
    this.$feedback = document.getElementById('feedbackLink');
    this.$menu = document.getElementById('profileMenu');
  }

  async init() {
    await Promise.all([
      this.ensureProfileState(),
      this.loadCurrentTab()
    ]);
    this.ensureHeaderInput(this.config);
    this.render();
    this.bindEvents();
    this._initialized = true;
    this.updateControlsUI();

    if (FEEDBACK_URL && this.$feedback) {
      this.$feedback.href = FEEDBACK_URL;
      this.$feedback.hidden = false;
    }
  }

  async sendMessage(message) {
    return globalThis.chrome?.runtime?.sendMessage(message);
  }

  async fetchProfileState() {
    try {
      const response = await this.sendMessage({ action: 'getProfileState' });
      if (response?.success && Array.isArray(response.data?.profiles)) {
        return response.data;
      }
    } catch (_) {}

    try {
      const response = await this.sendMessage({ action: 'getConfigs' });
      if (response?.success && Array.isArray(response.data)) {
        return {
          profiles: response.data,
          selectedProfileId: response.data[0]?.id || '',
          profileModeActivated: response.data.length > 1
        };
      }
    } catch (_) {}

    try {
      const stored = await globalThis.chrome?.storage?.local?.get?.([
        'configs',
        'popupState'
      ]);
      const profiles = Array.isArray(stored?.configs) ? stored.configs : [];
      return {
        profiles,
        selectedProfileId: stored?.popupState?.selectedProfileId || profiles[0]?.id || '',
        profileModeActivated: !!stored?.popupState?.profileModeActivated
          || profiles.length > 1
      };
    } catch (_) {
      return { profiles: [], selectedProfileId: '', profileModeActivated: false };
    }
  }

  applyProfileState(state) {
    this.profiles = (state?.profiles || []).map(profile => new Config(profile));
    this.selectedProfileId = state?.selectedProfileId || this.profiles[0]?.id || '';
    this.profileModeActivated = !!state?.profileModeActivated
      || this.profiles.length > 1;
    this.config = this.profiles.find(profile =>
      profile.id === this.selectedProfileId
    ) || this.profiles[0] || null;
    if (this.config) this.selectedProfileId = this.config.id;
  }

  async ensureProfileState() {
    let state = await this.fetchProfileState();
    if (!state.profiles.length) {
      try {
        const response = await this.sendMessage({
          action: 'addConfig',
          data: {
            name: 'Default',
            active: false,
            headers: [],
            scope: { type: 'all', value: '' }
          }
        });
        if (response?.success) {
          state = {
            profiles: [response.data],
            selectedProfileId: response.data.id,
            profileModeActivated: false
          };
        }
      } catch (_) {}
    }

    if (!state.profiles.length) {
      const fallback = new Config({
        name: 'Default',
        active: false,
        headers: []
      });
      state = {
        profiles: [fallback.toJSON()],
        selectedProfileId: fallback.id,
        profileModeActivated: false
      };
    }
    this.applyProfileState(state);
  }

  async refreshProfileState() {
    const state = await this.fetchProfileState();
    if (state.profiles.length) this.applyProfileState(state);
    return this.config;
  }

  async loadCurrentTab() {
    try {
      const tabs = await globalThis.chrome?.tabs?.query?.({
        active: true,
        currentWindow: true
      });
      const value = tabs?.[0]?.url || '';
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return;
      this.currentTabUrl = url.href;
      this.currentTabHost = url.hostname;
      const parts = url.hostname.split('.').filter(Boolean);
      this.currentTabRoot = parts.length > 1
        ? parts.slice(-2).join('.')
        : url.hostname;
    } catch (_) {}
  }

  ensureHeaderInput(profile) {
    if (!profile || profile.headers.length) return;
    profile.headers = [{
      name: '',
      value: '',
      enabled: true,
      type: 'request'
    }];
  }

  render() {
    if (!this.config) return;
    this.ensureHeaderInput(this.config);
    this.renderIdentity();
    this.renderHeaders();
    this.renderFilters();
    this.renderMenu();
    this.updateControlsUI();
  }

  renderIdentity() {
    const renamingHere = this.renamingId === this.config.id
      && this.renameLocation === 'header';
    if (this.$profileContext) this.$profileContext.hidden = renamingHere;
    if (this.$profileRename) this.$profileRename.hidden = !renamingHere;
    if (this.$profileRenameInput && renamingHere) {
      this.$profileRenameInput.value = this.renameDraft;
    }
    if (this.$profileName) {
      this.$profileName.textContent = this.profileModeActivated
        ? this.config.name
        : 'VibeHeader';
    }
    this.$profileTrigger?.setAttribute('aria-expanded', String(this.menuOpen));
  }

  renderHeaders() {
    if (!this.$headers) return;
    const paused = getPopupUiState(this.config).paused;
    this.$headers.innerHTML = this.config.headers.map((header, index) => {
      const overriding = findOverridingProfile(
        this.profiles,
        this.config.id,
        header
      );
      const invalidName = !!String(header.name || '').trim()
        && ValidationUtils.validateHeaderName(header.name).length > 0;
      return `
      <div class="vh-header-row ${overriding ? 'is-overridden' : ''}"
        data-header-id="${this.escape(header.id)}" data-index="${index}">
        <input type="checkbox" class="vh-h-enabled" ${header.enabled !== false ? 'checked' : ''}
          aria-label="Toggle header" ${paused ? 'disabled' : ''}>
        <input class="vh-input vh-h-name" placeholder="Name" value="${this.escape(header.name)}"
          aria-label="Header name" aria-invalid="${invalidName}" ${paused ? 'disabled' : ''}>
        <input class="vh-input vh-h-value" placeholder="Value" value="${this.escape(header.value)}"
          aria-label="Header value" ${paused ? 'disabled' : ''}>
        <button class="vh-del vh-del-header" type="button" aria-label="Delete header"
          title="Delete" ${paused ? 'disabled' : ''}>${ICON.x}</button>
        <div class="vh-header-override" ${overriding ? '' : 'hidden'}>
          ${overriding
    ? `Overridden by “${this.escape(overriding.name)}” on matching requests`
    : ''}
        </div>
      </div>
    `;
    }).join('');

    if (this._pendingHeaderFocus !== null) {
      const id = this._pendingHeaderFocus;
      this._pendingHeaderFocus = null;
      setTimeout(() => {
        this.$headers
          ?.querySelector(`[data-header-id="${selectorValue(id)}"] .vh-h-name`)
          ?.focus();
      }, 0);
    }
  }

  updateHeaderOverrideWarnings() {
    if (!this.$headers || !this.config) return;
    this.config.headers.forEach(header => {
      const warning = this.$headers.querySelector(
        `[data-header-id="${selectorValue(header.id)}"] .vh-header-override`
      );
      if (!warning) return;
      const overriding = findOverridingProfile(
        this.profiles,
        this.config.id,
        header
      );
      warning.closest('.vh-header-row')
        ?.classList.toggle('is-overridden', !!overriding);
      warning.hidden = !overriding;
      warning.textContent = overriding
        ? `Overridden by “${overriding.name}” on matching requests`
        : '';
    });
  }

  filterSuggestions() {
    if (!this.currentTabUrl) return [];
    const suggestions = [
      {
        id: 'host',
        label: 'Current host',
        value: this.currentTabHost
      }
    ];
    if (this.currentTabRoot) {
      suggestions.push({
        id: 'domain',
        label: 'Domain + subdomains',
        value: `*.${this.currentTabRoot}`
      });
    }
    suggestions.push({
      id: 'prefix',
      label: 'Current URL prefix',
      value: `${this.currentTabUrl}*`
    });
    return suggestions;
  }

  renderSuggestions() {
    const suggestions = this.filterSuggestions();
    if (!suggestions.length) return '';
    return `
      <div class="vh-suggestions" role="group" aria-label="Recommended filter values" hidden>
        <div class="vh-suggestions-title">From this page</div>
        ${suggestions.map(suggestion => `
          <button class="vh-suggestion" type="button" data-suggestion="${suggestion.id}"
            title="${this.escape(suggestion.value)}">
            <span class="vh-suggestion-value">${this.escape(suggestion.value)}</span>
            <span class="vh-suggestion-label">${this.escape(suggestion.label)}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  filterSummaryText() {
    const entered = this.config.filters.filter(filter =>
      String(filter.expression || '').trim()
    );
    if (!entered.length) return 'All requests';
    const validEntered = entered.filter(filter =>
      normalizeRequestMatch(filter).validation.valid
    );
    if (!validEntered.length) return 'All requests';
    const valid = validEntered.filter(filter => filter.enabled !== false);
    if (valid.length) {
      return `${String(valid[0].expression).trim()}${valid.length > 1 ? `  +${valid.length - 1}` : ''}`;
    }
    return 'No active filters';
  }

  filterTabTag() {
    const paused = getPopupUiState(this.config).paused;
    const entered = this.config.filters.filter(filter =>
      String(filter.expression || '').trim()
    );
    const validEntered = entered.filter(filter =>
      normalizeRequestMatch(filter).validation.valid
    );
    const enabled = validEntered.filter(filter =>
      filter.enabled !== false
    );
    if (paused) return '<span class="vh-tag vh-tag-paused">Paused</span>';
    if (!validEntered.length) {
      return '<span class="vh-tag vh-tag-on"><i></i>Active on this tab</span>';
    }
    if (!enabled.length) {
      return '<span class="vh-tag vh-tag-off"><i></i>Not on this tab</span>';
    }
    if (!this.currentTabUrl) {
      return '<span class="vh-tag vh-tag-off"><i></i>Not on this tab</span>';
    }
    const normalized = enabled.map(normalizeRequestMatch);
    if (normalized
      .filter(filter => filter.effectiveType !== 'regex')
      .some(filter => requestMatchMatchesUrl(filter, this.currentTabUrl))) {
      return '<span class="vh-tag vh-tag-on"><i></i>Active on this tab</span>';
    }
    if (normalized.some(filter => filter.effectiveType === 'regex')) {
      // Precise Regex matching is available in the isolated URL tester. The
      // passive tab badge must never run a user pattern on the UI thread.
      return '<span class="vh-tag vh-tag-on"><i></i>Active with regex</span>';
    }
    return '<span class="vh-tag vh-tag-off"><i></i>Not on this tab</span>';
  }

  renderFilterRows() {
    const paused = getPopupUiState(this.config).paused;
    const testUrl = this.normalizedTestUrl(this.testValue);
    const showMarks = this.testerOpen
      && this.testSubmitted
      && !this.testPending
      && !this.testError
      && !!testUrl;
    return this.config.filters.map((filter, index) => {
      const expression = String(filter.expression || '');
      const normalized = normalizeRequestMatch(filter);
      const invalid = !!expression.trim()
        && !normalized.validation.valid;
      const errorId = `vh-filter-error-${index}`;
      const errorReason = invalid ? normalized.validation.reason : '';
      const matches = showMarks
        && this.testMatchedFilterIds.has(filter.id);
      const mark = showMarks
        ? `<span class="vh-filter-mark ${matches ? 'is-match' : 'is-miss'}" aria-hidden="true">
            ${matches ? ICON.check : ICON.dash}
          </span>`
        : '';
      return `
        <div class="vh-filter-row" data-filter-id="${this.escape(filter.id)}">
          <input class="vh-filter-enabled" type="checkbox" ${filter.enabled !== false ? 'checked' : ''}
            aria-label="Toggle filter" ${paused ? 'disabled' : ''}>
          <div class="vh-filter-field ${showMarks ? 'has-mark' : ''}">
            <input class="vh-input vh-filter-value" value="${this.escape(expression)}"
              placeholder="Domain, URL, wildcard, or regex" aria-label="Request filter"
              aria-invalid="${invalid}" aria-describedby="${errorId}"
              autocomplete="off" ${paused ? 'disabled' : ''}>
            ${mark}
            ${this.renderSuggestions()}
          </div>
          <button class="vh-del vh-del-filter" type="button" aria-label="Delete filter"
            title="Delete" ${paused ? 'disabled' : ''}>${ICON.x}</button>
          <div class="vh-filter-error" id="${errorId}"
            ${errorReason ? '' : 'hidden'}>${this.escape(errorReason)}</div>
        </div>
      `;
    }).join('');
  }

  renderFilters() {
    if (!this.$filtersSection) return;
    const filters = this.config.filters;
    const hasFilters = filters.length > 0;
    this.$filtersSection.hidden = !hasFilters;
    if (!hasFilters) {
      this.filtersOpen = false;
      this.closeTester(false);
      return;
    }

    if (this.$filtersSummary) {
      this.$filtersSummary.setAttribute('aria-expanded', String(this.filtersOpen));
      this.$filtersSummary.innerHTML = `
        <span class="vh-filter-label">Applies to</span>
        <span class="vh-filter-summary-value">${this.escape(this.filterSummaryText())}</span>
        ${this.filterTabTag()}
        <svg class="vh-chevron" width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.4"
          stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      `;
    }
    if (this.$filtersPanel) this.$filtersPanel.hidden = !this.filtersOpen;
    if (this.$filters) {
      this.$filters.innerHTML = this.filtersOpen ? this.renderFilterRows() : '';
    }
    if (this.$tester) this.$tester.hidden = !this.testerOpen || !this.filtersOpen;
    if (this.$testUrl) {
      this.$testUrl.hidden = this.testerOpen;
      this.$testUrl.setAttribute('aria-expanded', String(this.testerOpen));
    }
    if (this.$testerInput && this.$testerInput.value !== this.testValue) {
      this.$testerInput.value = this.testValue;
    }
    if (this.$testerRun) {
      this.$testerRun.disabled = getPopupUiState(this.config).paused
        || !this.testValue.trim()
        || this.testPending;
    }
    this.renderTestResult();

    if (this._pendingFilterFocus !== null) {
      const id = this._pendingFilterFocus;
      this._pendingFilterFocus = null;
      setTimeout(() => {
        this.$filters
          ?.querySelector(`[data-filter-id="${selectorValue(id)}"] .vh-filter-value`)
          ?.focus();
      }, 0);
    }
  }

  profileMeta(profile) {
    const headers = headerCount(profile);
    const filters = profile.filters.length;
    const headerText = `${headers} ${headers === 1 ? 'header' : 'headers'}`;
    const filterText = filters
      ? `${filters} ${filters === 1 ? 'filter' : 'filters'}`
      : 'all requests';
    return `${headerText} · ${filterText}`;
  }

  renderMenu() {
    if (!this.$menu) return;
    this.$menu.hidden = !this.menuOpen;
    if (!this.menuOpen) return;

    this.$menu.innerHTML = `
      <div class="vh-menu-heading"><span>Profiles</span></div>
      <div class="vh-profile-list">
        ${this.profiles.map(profile => {
    const renaming = this.renamingId === profile.id
            && this.renameLocation === 'row';
    const selected = profile.id === this.selectedProfileId;
    return `
            <div class="vh-profile-block">
              ${renaming ? `
                <div class="vh-profile-row is-renaming ${selected ? 'is-selected' : ''}"
                  data-profile-id="${this.escape(profile.id)}">
                  <button class="vh-profile-switch ${profile.active ? 'is-on' : ''}"
                    type="button" aria-pressed="${profile.active}"
                    aria-label="Toggle ${this.escape(profile.name)}"></button>
                  <input class="vh-rename-input" value="${this.escape(this.renameDraft)}"
                    aria-label="Profile name">
                  <button class="vh-save-name vh-save-row" type="button">Save</button>
                </div>
              ` : `
                <div class="vh-profile-row ${selected ? 'is-selected' : ''}"
                  data-profile-id="${this.escape(profile.id)}">
                  <button class="vh-profile-switch ${profile.active ? 'is-on' : ''}"
                    type="button" aria-pressed="${profile.active}"
                    title="${profile.active ? 'Running — click to pause' : 'Paused — click to resume'}"
                    aria-label="Toggle ${this.escape(profile.name)}"></button>
                  <button class="vh-profile-select" type="button">
                    <span class="vh-profile-row-name">${this.escape(profile.name)}</span>
                    <span class="vh-profile-meta">${this.escape(this.profileMeta(profile))}</span>
                  </button>
                  <button class="vh-profile-icon vh-profile-rename" type="button"
                    title="Rename" aria-label="Rename ${this.escape(profile.name)}">${ICON.pencil}</button>
                  <button class="vh-profile-icon vh-profile-more" type="button"
                    title="More" aria-label="Actions for ${this.escape(profile.name)}">${ICON.dots}</button>
                </div>
              `}
              ${this.rowMenuId === profile.id ? `
                <div class="vh-row-menu">
                  <button class="vh-menu-action vh-copy-profile" type="button"
                    data-id="${this.escape(profile.id)}">${ICON.link}Copy link</button>
                  <button class="vh-menu-action vh-duplicate-profile" type="button"
                    data-id="${this.escape(profile.id)}">${ICON.copy}Duplicate</button>
                  <button class="vh-menu-action is-danger vh-delete-profile" type="button"
                    data-id="${this.escape(profile.id)}">${ICON.trash}Delete</button>
                </div>
              ` : ''}
            </div>
          `;
  }).join('')}
      </div>
      <div class="vh-menu-footer">
        <button class="vh-menu-action vh-new-profile" type="button">${ICON.plus}Add profile</button>
      </div>
    `;
  }

  updateControlsUI() {
    if (!this.config) return;
    const state = getPopupUiState(this.config);
    if (this.$popup) this.$popup.classList.toggle('is-paused', state.paused);
    if (this.$banner) this.$banner.hidden = !state.paused;
    if (this.$bannerText && state.paused) {
      const otherActiveProfiles = this.profiles.filter(profile =>
        profile.id !== this.config.id
        && profile.active === true
        && hasEffectiveHeaders(profile.headers)
      ).length;
      this.$bannerText.innerHTML = otherActiveProfiles
        ? `<strong>Paused.</strong> ${otherActiveProfiles} other ${otherActiveProfiles === 1 ? 'profile is' : 'profiles are'} still active.`
        : '<strong>Paused.</strong> Headers aren’t being applied.';
    }
    if (this.$toggle) {
      this.$toggle.hidden = !state.actionsVisible;
      this.$toggle.disabled = !state.actionsVisible;
      this.$toggle.setAttribute('data-enabled', String(state.enabled));
      this.$toggle.setAttribute('aria-pressed', String(state.enabled));
      this.$toggle.innerHTML = state.enabled
        ? `${ICON.pause}<span>Pause</span>`
        : `${ICON.play}<span>Resume</span>`;
    }
    if (this.$share) {
      this.$share.hidden = !state.actionsVisible;
      this.$share.disabled = !state.actionsVisible;
    }
    if (this.$addHeader) {
      this.$addHeader.disabled = !this._initialized || state.paused;
    }
    if (this.$addFilter) {
      const atFilterLimit =
        this.config.filters.length >= RequestFilterLimits.MAX_FILTERS_PER_PROFILE;
      this.$addFilter.disabled = !this._initialized || state.paused || atFilterLimit;
      if (atFilterLimit) {
        this.$addFilter.title =
          `Up to ${RequestFilterLimits.MAX_FILTERS_PER_PROFILE} filters per Profile`;
      } else {
        this.$addFilter.removeAttribute('title');
      }
    }
    if (this.$filtersSummary) this.$filtersSummary.disabled = state.paused;
  }

  bindEvents() {
    this.$addHeader?.addEventListener('click', () => this.addHeader());
    this.$addFilter?.addEventListener('click', () => this.addFilter());
    this.$toggle?.addEventListener('click', () =>
      this.toggleProfile(this.config.id, !this.config.active)
    );
    this.$share?.addEventListener('click', () =>
      this.copyProfileLink(this.config, this.$share)
    );
    this.$profileTrigger?.addEventListener('click', () => {
      this.menuOpen = !this.menuOpen;
      this.rowMenuId = null;
      this.renderIdentity();
      this.renderMenu();
    });
    this.$profileRenameSave?.addEventListener('click', () =>
      this.finishRename('header')
    );
    this.$filtersSummary?.addEventListener('click', () => {
      this.filtersOpen = !this.filtersOpen;
      if (!this.filtersOpen) this.closeTester(false);
      this.renderFilters();
    });
    this.$testUrl?.addEventListener('click', () => {
      this.testerOpen = true;
      this.testValue = '';
      this.testSubmitted = false;
      this.renderFilters();
      setTimeout(() => this.$testerInput?.focus(), 0);
    });
    this.$testerDone?.addEventListener('click', () => this.closeTester(true));
    this.$testerRun?.addEventListener('click', () => this.runUrlTest());

    this.$headers?.addEventListener('input', event => {
      if (event.target.matches('.vh-h-name, .vh-h-value')) {
        if (event.target.matches('.vh-h-name')) {
          const invalid = !!event.target.value.trim()
            && ValidationUtils.validateHeaderName(event.target.value).length > 0;
          event.target.setAttribute('aria-invalid', String(invalid));
        }
        this.persistCurrentState();
        this.updateHeaderOverrideWarnings();
      }
    });
    this.$headers?.addEventListener('change', event => {
      if (event.target.matches('.vh-h-enabled')) {
        this.persistCurrentState();
        this.updateHeaderOverrideWarnings();
      }
    });
    this.$headers?.addEventListener('click', event => {
      const button = event.target.closest('.vh-del-header');
      if (!button) return;
      this.deleteHeader(button.closest('.vh-header-row')?.dataset.headerId);
    });
    this.$headers?.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      if (event.target.matches('.vh-h-name')) {
        event.preventDefault();
        event.target.closest('.vh-header-row')
          ?.querySelector('.vh-h-value')
          ?.focus();
      } else if (event.target.matches('.vh-h-value')) {
        event.preventDefault();
        this.addHeader();
      }
    });

    this.$filters?.addEventListener('input', event => {
      if (!event.target.matches('.vh-filter-value')) return;
      const row = event.target.closest('.vh-filter-row');
      const id = row?.dataset.filterId;
      const normalized = normalizeRequestMatch({
        expression: event.target.value
      });
      this.stopFilterTestWorker();
      this.updateFilter(id, {
        expression: event.target.value,
        runtimeValidationReason: ''
      }, true);
      const suggestions = event.target
        .closest('.vh-filter-field')
        ?.querySelector('.vh-suggestions');
      if (suggestions) suggestions.hidden = !!event.target.value.trim();
      const invalid = !!event.target.value.trim()
        && !normalized.validation.valid;
      event.target.setAttribute('aria-invalid', String(invalid));
      const error = row?.querySelector('.vh-filter-error');
      if (error) {
        error.hidden = !invalid;
        error.textContent = invalid ? normalized.validation.reason : '';
      }
      this.updateFilterSummaryOnly();
    });
    this.$filters?.addEventListener('change', event => {
      if (!event.target.matches('.vh-filter-enabled')) return;
      const id = event.target.closest('.vh-filter-row')?.dataset.filterId;
      this.updateFilter(id, { enabled: event.target.checked });
      this.renderFilters();
    });
    this.$filters?.addEventListener('click', event => {
      const deleteButton = event.target.closest('.vh-del-filter');
      if (deleteButton) {
        const id = deleteButton.closest('.vh-filter-row')?.dataset.filterId;
        this.deleteFilter(id);
        return;
      }
      const suggestion = event.target.closest('[data-suggestion]');
      if (!suggestion) return;
      const value = this.filterSuggestions().find(item =>
        item.id === suggestion.dataset.suggestion
      )?.value;
      const id = suggestion.closest('.vh-filter-row')?.dataset.filterId;
      if (!value || !id) return;
      this.updateFilter(id, { expression: value }, true);
      this.renderFilters();
      setTimeout(() => {
        const input = this.$filters?.querySelector(
          `[data-filter-id="${selectorValue(id)}"] .vh-filter-value`
        );
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }, 0);
    });
    this.$filters?.addEventListener('pointerdown', event => {
      if (event.target.closest('.vh-suggestion')) {
        // Keep the Filter input focused until the selected suggestion is
        // applied and the row is redrawn.
        event.preventDefault();
      }
    });
    this.$filters?.addEventListener('focusin', event => {
      if (!event.target.matches('.vh-filter-value')
        || event.target.value.trim()) return;
      const suggestions = event.target
        .closest('.vh-filter-field')
        ?.querySelector('.vh-suggestions');
      this.$filters.querySelectorAll('.vh-suggestions').forEach(panel => {
        panel.hidden = panel !== suggestions;
      });
      if (suggestions) suggestions.hidden = false;
    });

    this.$testerInput?.addEventListener('input', event => {
      this.stopFilterTestWorker();
      this.testValue = event.target.value;
      this.testSubmitted = false;
      this.testPending = false;
      this.testError = '';
      this.testMatchedFilterIds.clear();
      this.$testerRun.disabled = !this.testValue.trim();
      this.renderTestResult();
    });
    this.$testerInput?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.runUrlTest();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeTester(true);
      }
    });

    this.$menu?.addEventListener('click', event => this.handleMenuClick(event));
    document.addEventListener('input', event => {
      if (event.target === this.$profileRenameInput
        || event.target.matches('.vh-rename-input')) {
        this.renameDraft = event.target.value;
      }
    });
    document.addEventListener('focusout', event => this.handleRenameBlur(event));
    document.addEventListener('keydown', event => this.handleKeydown(event));
    document.addEventListener('pointerdown', event => {
      const path = event.composedPath();
      this.$filters?.querySelectorAll('.vh-suggestions').forEach(suggestions => {
        if (!path.includes(suggestions.closest('.vh-filter-field'))) {
          suggestions.hidden = true;
        }
      });
    });
    document.addEventListener('click', event => {
      const path = event.composedPath();
      if (path.includes(this.$menu)
        || path.includes(this.$profileTrigger)
        || path.includes(this.$profileRename)) return;
      if (this.menuOpen) {
        this.menuOpen = false;
        this.rowMenuId = null;
        this.renderIdentity();
        this.renderMenu();
      }
    });
  }

  async handleMenuClick(event) {
    const row = event.target.closest('[data-profile-id]');
    const id = row?.dataset.profileId
      || event.target.closest('[data-id]')?.dataset.id;
    if (event.target.closest('.vh-save-row')) {
      this.finishRename('row');
    } else if (event.target.closest('.vh-profile-rename')) {
      this.beginRename(id, 'row');
    } else if (event.target.closest('.vh-profile-more')) {
      this.rowMenuId = this.rowMenuId === id ? null : id;
      this.renderMenu();
    } else if (event.target.closest('.vh-profile-switch')) {
      const profile = this.profiles.find(item => item.id === id);
      if (profile) await this.toggleProfile(id, !profile.active);
    } else if (event.target.closest('.vh-profile-select')) {
      await this.selectProfile(id);
    } else if (event.target.closest('.vh-new-profile')) {
      await this.createProfile();
    } else if (event.target.closest('.vh-copy-profile')) {
      const profile = this.profiles.find(item => item.id === id);
      if (profile) await this.copyProfileLink(profile);
      this.closeMenu();
    } else if (event.target.closest('.vh-duplicate-profile')) {
      await this.duplicateProfile(id);
    } else if (event.target.closest('.vh-delete-profile')) {
      await this.confirmAndDeleteProfile(id);
    }
  }

  handleRenameBlur(event) {
    const location = event.target === this.$profileRenameInput
      ? 'header'
      : event.target.matches('.vh-rename-input') ? 'row' : null;
    if (!location) return;
    const id = this.renamingId;
    setTimeout(() => {
      if (id !== this.renamingId || location !== this.renameLocation) return;
      const container = location === 'header'
        ? this.$profileRename
        : this.$menu?.querySelector('.vh-profile-row.is-renaming');
      if (container?.contains(document.activeElement)) return;
      this.finishRename(location);
    }, 0);
  }

  handleKeydown(event) {
    const renameInput = event.target === this.$profileRenameInput
      || event.target.matches('.vh-rename-input');
    if (renameInput && event.key === 'Enter') {
      event.preventDefault();
      this.finishRename(this.renameLocation);
      return;
    }
    if (renameInput && event.key === 'Escape') {
      event.preventDefault();
      this.cancelRename();
      return;
    }
    if (event.key === 'Escape' && this.menuOpen) {
      this.closeMenu();
      this.$profileTrigger?.focus();
    } else if (event.key === 'Escape' && this.filtersOpen) {
      this.filtersOpen = false;
      this.closeTester(false);
      this.renderFilters();
    }
  }

  syncHeadersFromDom() {
    if (!this.$headers || !this.config) return;
    const rows = [...this.$headers.querySelectorAll('.vh-header-row')];
    if (!rows.length) return;
    this.config.headers = rows.map(row => ({
      id: row.dataset.headerId,
      type: 'request',
      name: row.querySelector('.vh-h-name')?.value || '',
      value: row.querySelector('.vh-h-value')?.value || '',
      enabled: !!row.querySelector('.vh-h-enabled')?.checked
    }));
  }

  addHeader() {
    if (getPopupUiState(this.config).paused) return;
    this.syncHeadersFromDom();
    const headers = this.config.headers;
    headers.push({ name: '', value: '', enabled: true, type: 'request' });
    this.config.headers = headers;
    this._pendingHeaderFocus = this.config.headers.at(-1).id;
    this.renderHeaders();
    this.persistProfile(this.config);
  }

  deleteHeader(id) {
    if (!id || getPopupUiState(this.config).paused) return;
    this.syncHeadersFromDom();
    this.config.headers = this.config.headers.filter(header => header.id !== id);
    this.ensureHeaderInput(this.config);
    this.renderHeaders();
    this.persistProfile(this.config);
  }

  addFilter() {
    if (getPopupUiState(this.config).paused) return;
    if (this.config.filters.length >= RequestFilterLimits.MAX_FILTERS_PER_PROFILE) {
      return;
    }
    const filters = this.config.filters;
    filters.push(normalizeRequestMatch({ expression: '', enabled: true }));
    this.config.filters = filters;
    this.filtersOpen = true;
    this.testerOpen = false;
    this.testValue = '';
    this.testSubmitted = false;
    this._pendingFilterFocus = this.config.filters.at(-1).id;
    this.renderFilters();
    this.persistProfile(this.config);
  }

  updateFilter(id, changes, touched = false) {
    if (!id || getPopupUiState(this.config).paused) return;
    const filters = this.config.filters.map(filter =>
      filter.id === id
        ? normalizeRequestMatch({ ...filter, ...changes })
        : filter
    );
    this.config.filters = filters;
    if (touched) this.touchedFilters.add(id);
    this.testSubmitted = false;
    this.updateHeaderOverrideWarnings();
    this.persistProfile(this.config);
  }

  deleteFilter(id) {
    if (!id || getPopupUiState(this.config).paused) return;
    this.config.filters = this.config.filters.filter(filter => filter.id !== id);
    this.touchedFilters.delete(id);
    this.testSubmitted = false;
    if (!this.config.filters.length) {
      this.filtersOpen = false;
      this.closeTester(false);
    }
    this.renderFilters();
    this.persistProfile(this.config);
  }

  updateFilterSummaryOnly() {
    const summary = this.$filtersSummary;
    if (!summary) return;
    const value = summary.querySelector('.vh-filter-summary-value');
    if (value) value.textContent = this.filterSummaryText();
    const tag = summary.querySelector('.vh-tag');
    if (tag) tag.outerHTML = this.filterTabTag();
  }

  normalizedTestUrl(value) {
    const candidate = String(value || '').trim();
    if (!candidate
      || candidate.length > RequestFilterLimits.MAX_TEST_URL_LENGTH
      || /\s/.test(candidate)) return null;
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
      ? candidate
      : `https://${candidate}`;
    try {
      const url = new URL(withProtocol);
      return /^https?:$/.test(url.protocol) && url.hostname
        ? url.href
        : null;
    } catch (_) {
      return null;
    }
  }

  validTestUrl(value) {
    return !!this.normalizedTestUrl(value);
  }

  stopFilterTestWorker() {
    if (this._filterTestTimer) {
      clearTimeout(this._filterTestTimer);
      this._filterTestTimer = null;
    }
    this._filterTestWorker?.terminate();
    this._filterTestWorker = null;
  }

  runFilterTestSynchronously(testUrl) {
    const hasRegex = this.config.filters.some(filter => {
      const normalized = normalizeRequestMatch(filter);
      return normalized.enabled !== false
        && normalized.validation.valid
        && normalized.effectiveType === 'regex';
    });
    if (hasRegex) {
      this.testPending = false;
      this.testError = 'Regex testing is unavailable';
      this.renderFilters();
      return;
    }
    this.testMatchedFilterIds = new Set(
      this.config.filters
        .filter(filter => requestMatchMatchesUrl(filter, testUrl))
        .map(filter => filter.id)
    );
    this.testPending = false;
    this.renderFilters();
  }

  markFilterTestTimeout(filterId) {
    const reason = 'Filter is too complex to test safely';
    if (filterId) {
      const filters = this.config.filters.map(filter =>
        filter.id === filterId
          ? normalizeRequestMatch({
            ...filter,
            runtimeValidationReason: reason
          })
          : filter
      );
      this.config.filters = filters;
      this.touchedFilters.add(filterId);
      this.persistProfile(this.config);
    }
    this.testPending = false;
    this.testError = reason;
    this.renderFilters();
  }

  runUrlTest() {
    if (!this.testerOpen || !this.testValue.trim()) return;
    this.stopFilterTestWorker();
    this.testSubmitted = true;
    this.testPending = false;
    this.testError = '';
    this.testMatchedFilterIds.clear();

    const testUrl = this.normalizedTestUrl(this.testValue);
    if (!testUrl) {
      this.renderFilters();
      return;
    }

    const WorkerClass = globalThis.Worker;
    const workerUrl = globalThis.chrome?.runtime?.getURL?.('filter-match-worker.js');
    if (typeof WorkerClass !== 'function' || !workerUrl) {
      this.runFilterTestSynchronously(testUrl);
      return;
    }

    const runId = ++this._filterTestRunId;
    let activeFilterId = null;
    try {
      this._filterTestWorker = new WorkerClass(workerUrl);
    } catch (_) {
      this.runFilterTestSynchronously(testUrl);
      return;
    }

    this.testPending = true;
    this._filterTestWorker.onmessage = event => {
      const message = event.data || {};
      if (message.runId !== runId) return;

      if (message.type === 'started') {
        activeFilterId = message.filterId;
        if (this._filterTestTimer) clearTimeout(this._filterTestTimer);
        this._filterTestTimer = setTimeout(() => {
          const timedOutFilterId = activeFilterId;
          this.stopFilterTestWorker();
          this.markFilterTestTimeout(timedOutFilterId);
        }, RequestFilterLimits.REGEX_TEST_TIMEOUT_MS);
        return;
      }

      if (message.type === 'result') {
        if (this._filterTestTimer) {
          clearTimeout(this._filterTestTimer);
          this._filterTestTimer = null;
        }
        if (message.matches) this.testMatchedFilterIds.add(message.filterId);
        activeFilterId = null;
        return;
      }

      if (message.type === 'done') {
        this.stopFilterTestWorker();
        this.testPending = false;
        this.renderFilters();
      }
    };
    this._filterTestWorker.onerror = () => {
      this.stopFilterTestWorker();
      this.markFilterTestTimeout(activeFilterId);
    };
    this._filterTestWorker.postMessage({
      runId,
      candidateUrl: testUrl,
      filters: this.config.filters
    });
    this.renderFilters();
  }

  renderTestResult() {
    if (!this.$testerResult || !this.$testerInput) return;
    this.$testerResult.className = 'vh-tester-result';
    this.$testerInput.setAttribute('aria-invalid', 'false');
    if (!this.testSubmitted) {
      this.$testerResult.hidden = true;
      this.$testerResult.innerHTML = '';
      return;
    }
    this.$testerResult.hidden = false;
    if (this.testPending) {
      this.$testerResult.textContent = 'Testing…';
      return;
    }
    if (this.testError) {
      this.$testerResult.classList.add('is-miss');
      this.$testerResult.textContent = this.testError;
      return;
    }
    if (this.testValue.trim().length > RequestFilterLimits.MAX_TEST_URL_LENGTH) {
      this.$testerInput.setAttribute('aria-invalid', 'true');
      this.$testerResult.textContent =
        `Test URL must be ${RequestFilterLimits.MAX_TEST_URL_LENGTH} characters or fewer`;
      return;
    }
    if (!this.validTestUrl(this.testValue)) {
      this.$testerInput.setAttribute('aria-invalid', 'true');
      this.$testerResult.textContent = 'Enter a valid URL or domain';
      return;
    }
    const count = this.testMatchedFilterIds.size;
    this.$testerResult.classList.add(count ? 'is-match' : 'is-miss');
    this.$testerResult.innerHTML = count
      ? `${ICON.check}<span>${count === 1 ? 'Matched by 1 rule' : `Matched by ${count} rules`}</span>`
      : `${ICON.cross}<span>No rule matches this URL</span>`;
  }

  closeTester(focusButton) {
    this.stopFilterTestWorker();
    this.testerOpen = false;
    this.testValue = '';
    this.testSubmitted = false;
    this.testPending = false;
    this.testError = '';
    this.testMatchedFilterIds.clear();
    if (this.$tester) this.$tester.hidden = true;
    if (this.$testUrl && this.config?.filters.length && this.filtersOpen) {
      this.$testUrl.hidden = false;
      this.$testUrl.setAttribute('aria-expanded', 'false');
    }
    if (focusButton) setTimeout(() => this.$testUrl?.focus(), 0);
  }

  resetProfileView() {
    this.filtersOpen = false;
    this.closeTester(false);
    this.touchedFilters.clear();
  }

  closeMenu() {
    this.menuOpen = false;
    this.rowMenuId = null;
    this.renderIdentity();
    this.renderMenu();
  }

  async selectProfile(id) {
    if (!id || id === this.selectedProfileId) {
      this.closeMenu();
      return;
    }
    try {
      const response = await this.sendMessage({
        action: 'selectProfile',
        data: { id }
      });
      if (response?.success && response.data?.profiles) {
        this.applyProfileState(response.data);
      } else {
        this.selectedProfileId = id;
        this.config = this.profiles.find(profile => profile.id === id) || this.config;
      }
      this.resetProfileView();
      this.closeMenu();
      this.render();
    } catch (error) {
      console.warn(error?.message || 'Could not switch profile');
    }
  }

  beginRename(id, location) {
    const profile = this.profiles.find(item => item.id === id);
    if (!profile) return;
    this.renamingId = id;
    this.renameLocation = location;
    this.renameDraft = profile.name;
    this.rowMenuId = null;
    if (location === 'header') {
      this.selectedProfileId = id;
      this.config = profile;
      this.closeMenu();
    }
    this.render();
    setTimeout(() => {
      const input = location === 'header'
        ? this.$profileRenameInput
        : this.$menu?.querySelector('.vh-rename-input');
      input?.focus();
      input?.select();
    }, 0);
  }

  finishRename(location = this.renameLocation) {
    if (!this.renamingId || location !== this.renameLocation) return;
    const profile = this.profiles.find(item => item.id === this.renamingId);
    const nextName = this.renameDraft.trim();
    const changed = !!profile && !!nextName && nextName !== profile.name;
    if (changed) profile.name = nextName;
    this.renamingId = null;
    this.renameLocation = null;
    this.renameDraft = '';
    this.render();
    if (changed) {
      this.persistProfile(profile);
    }
  }

  cancelRename() {
    this.renamingId = null;
    this.renameLocation = null;
    this.renameDraft = '';
    this.render();
  }

  async createProfile() {
    try {
      const response = await this.sendMessage({ action: 'createProfile' });
      if (!response?.success) throw new Error(response?.error || 'Could not create profile');
      await this.refreshProfileState();
      this.profileModeActivated = true;
      this.resetProfileView();
      this.beginRename(this.selectedProfileId, 'header');
    } catch (error) {
      console.warn(error?.message || 'Could not create profile');
    }
  }

  async duplicateProfile(id) {
    try {
      const response = await this.sendMessage({
        action: 'duplicateProfile',
        data: { id }
      });
      if (!response?.success) throw new Error(response?.error || 'Could not duplicate profile');
      await this.refreshProfileState();
      this.profileModeActivated = true;
      this.resetProfileView();
      this.beginRename(this.selectedProfileId, 'header');
    } catch (error) {
      console.warn(error?.message || 'Could not duplicate profile');
    }
  }

  async confirmAndDeleteProfile(id) {
    const profile = this.profiles.find(item => item.id === id);
    if (!profile) return;
    const hasContent = profile.filters.length
      || profile.headers.some(header =>
        String(header.name || '').trim() || String(header.value || '').trim()
      );
    if (hasContent) {
      const confirmed = await this.confirmDialog({
        title: `Delete "${profile.name}"?`,
        body: `Its headers and filters will be removed${profile.active ? ' and it will stop running' : ''}. This can't be undone.`
      });
      if (!confirmed) return;
    }
    try {
      const response = await this.sendMessage({
        action: 'deleteProfile',
        data: { id }
      });
      if (!response?.success) throw new Error(response?.error || 'Could not delete profile');
      if (response.data?.state) {
        this.applyProfileState(response.data.state);
      } else {
        await this.refreshProfileState();
      }
      this.resetProfileView();
      this.closeMenu();
      this.render();
    } catch (error) {
      console.warn(error?.message || 'Could not delete profile');
    }
  }

  async toggleProfile(id, active) {
    const profile = this.profiles.find(item => item.id === id);
    if (!profile) return;
    const previous = profile.active;
    profile.active = !!active;
    if (!active && id === this.selectedProfileId) {
      this.filtersOpen = false;
      this.closeTester(false);
    }
    const revision = this.nextRevision(id);
    this.render();

    const mutation = Promise.resolve(this.sendMessage({
      action: 'toggleConfig',
      data: { id, enabled: !!active }
    })).then(response => {
      if (revision !== this.currentRevision(id)) return response;
      if (response?.success) {
        this.replaceProfile(response.data);
      } else {
        profile.active = previous;
        console.warn(response?.error || 'Could not update profile');
      }
      this.render();
      return response;
    }).catch(error => {
      if (revision === this.currentRevision(id)) {
        profile.active = previous;
        this.render();
      }
      console.warn(error?.message || 'Could not update profile');
    });
    this._lastMutationPromise = mutation;
    await mutation;
  }

  profileSharePayload(profile) {
    return {
      v: 2,
      n: profile.name,
      h: profile.headers
        .filter(header =>
          header.enabled !== false
          && !ValidationUtils.validateHeaderName(header.name).length
          && !ValidationUtils.validateHeaderValue(header.value).length
        )
        .map(header => [
          String(header.name).trim(),
          String(header.value ?? '')
        ]),
      f: profile.filters
        .filter(filter =>
          String(filter.expression || '').trim()
          && normalizeRequestMatch(filter).validation.valid
        )
        .map(filter => [
          String(filter.expression).trim(),
          filter.enabled !== false
        ])
    };
  }

  async copyProfileLink(profile, feedbackButton) {
    const serialized = JSON.stringify(this.profileSharePayload(profile));
    if (serializedUtf8Size(serialized) > RequestFilterLimits.MAX_SHARED_PROFILE_BYTES) {
      this.showButtonFeedback(feedbackButton, 'Profile too large', false);
      return false;
    }
    const payload = encodeURIComponent(serialized);
    const url = `${SHARE_URL}${payload}`;
    try {
      await navigator.clipboard.writeText(url);
      this.showButtonFeedback(feedbackButton, 'Copied!', true);
      return true;
    } catch (_) {
      console.log('Share URL:', url);
      this.showButtonFeedback(feedbackButton, 'Copy failed', false);
      return false;
    }
  }

  profileSnapshot(profile) {
    const canonical = profile.toJSON();
    return {
      ...canonical,
      // Temporary message aliases keep older extension contexts compatible.
      // ConfigService persists only the nested canonical model.
      enabled: profile.active,
      headers: clone(profile.headers),
      filters: clone(profile.filters)
    };
  }

  persistCurrentState() {
    this.syncHeadersFromDom();
    const previousActive = this.config.active;
    if (!previousActive && hasEffectiveHeaders(this.config.headers)) {
      this.config.active = true;
    }
    this.updateControlsUI();
    return this.persistProfile(this.config, previousActive);
  }

  persistProfile(profile, previousActive = profile.active) {
    const id = profile.id;
    const snapshot = this.profileSnapshot(profile);
    const revision = this.nextRevision(id);
    const mutation = Promise.resolve(this.sendMessage({
      action: 'updateConfig',
      data: { id, config: snapshot }
    })).then(response => {
      if (revision !== this.currentRevision(id)) return response;
      if (response?.success) {
        this.replaceProfile(response.data);
      } else {
        profile.active = previousActive;
        console.warn(response?.error || 'Save failed');
      }
      this.updateControlsUI();
      return response;
    }).catch(error => {
      if (revision === this.currentRevision(id)) {
        profile.active = previousActive;
        this.updateControlsUI();
      }
      console.warn(error?.message || 'Save failed');
    });
    this._lastMutationPromise = mutation;
    return mutation;
  }

  replaceProfile(data) {
    if (!data?.id) return;
    const profile = new Config(data);
    const index = this.profiles.findIndex(item => item.id === profile.id);
    if (index === -1) {
      this.profiles.push(profile);
    } else {
      this.profiles[index] = profile;
    }
    if (this.selectedProfileId === profile.id) this.config = profile;
  }

  nextRevision(id) {
    const revision = (this._profileRevisions.get(id) || 0) + 1;
    this._profileRevisions.set(id, revision);
    return revision;
  }

  currentRevision(id) {
    return this._profileRevisions.get(id) || 0;
  }

  showButtonFeedback(button, message, success) {
    if (!button) return;
    const original = button.dataset.feedbackOriginal || button.innerHTML;
    button.dataset.feedbackOriginal = original;
    clearTimeout(button._feedbackTimer);
    button.innerHTML = `${success ? ICON.copyCheck : ICON.cross}<span>${this.escape(message)}</span>`;
    button._feedbackTimer = setTimeout(() => {
      button.innerHTML = original;
      delete button.dataset.feedbackOriginal;
    }, 1200);
  }

  confirmDialog({ title, body }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'vh-overlay';
      overlay.innerHTML = `
        <div class="vh-modal" role="alertdialog" aria-modal="true">
          <h2>${this.escape(title)}</h2>
          <p>${this.escape(body)}</p>
          <div class="vh-modal-actions">
            <button class="vh-modal-button" data-action="cancel" type="button">Cancel</button>
            <button class="vh-modal-button is-danger" data-action="confirm" type="button">Delete</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const finish = value => {
        overlay.remove();
        resolve(value);
      };
      overlay.addEventListener('click', event => {
        if (event.target === overlay) return finish(false);
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action) finish(action === 'confirm');
      });
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') finish(false);
      });
      setTimeout(() => overlay.querySelector('[data-action="confirm"]')?.focus(), 0);
    });
  }

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      '\'': '&#39;'
    }[character]));
  }
}
