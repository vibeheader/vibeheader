import { ConfigService } from '../shared/services/ConfigService.js';
import { ValidationUtils } from '../shared/utils/validation.js';

// Background Service Worker
class BackgroundService {
  constructor() {
    this.configService = new ConfigService();
    this.isInitialized = false;
    this.readyPromise = null;
    this._ruleRefreshTimer = null;
  }

  // Init
  async init() {
    try {
      // expose a promise others can await to ensure configs are loaded
      this.readyPromise = this.configService.init();
      await this.readyPromise;
      this.setupEventListeners();
      // Sync enabled configs to DNR rules on startup
      try {
        await this.configService.updateNetworkRules();
      } catch (e) {
        console.warn('Initial rule sync failed (will retry on changes):', e?.message || e);
      }
      await this.updateActionState();
      this.isInitialized = true;
      console.log('VibeHeader background started');
    } catch (error) {
      console.error('Background init failed:', error);
    }
  }

  // Events
  setupEventListeners() {
    // onInstalled
    chrome.runtime.onInstalled.addListener((details) => {
      this.handleInstall(details);
    });

    // messaging
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // keep channel open
    });

    // storage changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.configs) {
        this.handleConfigsChanged();
      }
    });

    // Tab address changes (including SPA hash routes) must rebuild session rules
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (changeInfo.url || changeInfo.status === 'complete') {
        this.scheduleRuleRefresh();
        if (tab?.url) this.updateBadgeForTab(tab);
      }
    });
    chrome.tabs.onRemoved.addListener(() => {
      this.scheduleRuleRefresh();
    });
  }

  /**
   * Debounce DNR rebuilds while the user navigates quickly.
   */
  scheduleRuleRefresh() {
    clearTimeout(this._ruleRefreshTimer);
    this._ruleRefreshTimer = setTimeout(() => {
      this.configService.updateNetworkRules().catch(e => {
        console.warn('Rule refresh after tab change failed:', e?.message || e);
      });
    }, 120);
  }

  // Install/update
  async handleInstall(details) {
    if (details.reason === 'install') {
      console.log('VibeHeader first install');
      // create default config
      try {
        await this.createDefaultConfig();
      } catch (error) {
        console.error('Failed to create default config:', error);
      }

    } else if (details.reason === 'update') {
      console.log('VibeHeader updated to version:', chrome.runtime.getManifest().version);
    }
  }

  // Default config
  async createDefaultConfig() {
    // Default tab matches all URLs ("*" in the popup tab bar)
    const defaultConfig = {
      name: '*',
      enabled: false,
      headers: [],
      scope: { type: 'all', value: '' }
    };

    await this.configService.addConfig(defaultConfig);
  }

  // Messaging handler
  async handleMessage(message, sender, sendResponse) {
    try {
      // ensure configs are loaded before serving messages like getConfigs
      if (this.readyPromise) {
        await this.readyPromise.catch(() => {});
      }
      const { action, data } = message;

      switch (action) {
      case 'getConfigs':
        sendResponse({
          success: true,
          data: this.configService.getAllConfigs()
        });
        break;

      case 'addConfig': {
        const newConfig = await this.configService.addConfig(data);
        sendResponse({
          success: true,
          data: newConfig
        });
        break;
      }

      case 'updateConfig': {
        const updatedConfig = await this.configService.updateConfig(data.id, data.config);
        sendResponse({
          success: true,
          data: updatedConfig
        });
        break;
      }

      case 'toggleConfig': {
        const toggledConfig = await this.configService.toggleConfig(data.id, data.enabled);
        await this.updateActionState();
        sendResponse({
          success: true,
          data: toggledConfig
        });
        break;
      }

      case 'setGlobalEnabled': {
        await this.configService.setGlobalEnabled(!!data.enabled);
        await this.updateActionState();
        sendResponse({
          success: true,
          data: this.configService.getAllConfigs()
        });
        break;
      }

      case 'deleteConfig': {
        await this.configService.deleteConfig(data.id);
        await this.updateActionState();
        sendResponse({
          success: true,
          data: this.configService.getAllConfigs()
        });
        break;
      }

      case 'refreshRules': {
        // Popup asks to rebuild session rules against current tab URLs
        await this.configService.updateNetworkRules();
        await this.updateActionState();
        sendResponse({ success: true });
        break;
      }

      case 'importSharedKV': {
        const list = Array.isArray(data?.h) ? data.h : [];
        const candidate = list
          .filter(it => Array.isArray(it) && String(it[0] || '').trim())
          .map(([n, v]) => ({ name: String(n).trim(), value: String(v ?? ''), enabled: true, type: 'request' }));

        if (candidate.length === 0) {
          sendResponse({ success: false, error: 'No valid headers in shared link' });
          break;
        }

        // S3: security validation before anything is persisted. Block header/CRLF
        // injection and malformed names. We intentionally do NOT enforce the full
        // RESTRICTED_HEADERS UX list here — that would reject legitimate shares
        // (e.g. User-Agent) that the manual editor accepts, and DNR enforces its
        // own restrictions at rule time anyway.
        const bad = [];
        candidate.forEach((h, i) => {
          if (!/^[a-zA-Z0-9!#$&'*+.^_`|~-]+$/.test(h.name)) {
            bad.push(`#${i + 1} "${h.name}": invalid header name`);
          }
          const valErrs = ValidationUtils.validateHeaderValue(h.value);
          if (valErrs.length) bad.push(`#${i + 1} "${h.name}": ${valErrs.join(', ')}`);
        });
        if (bad.length) {
          sendResponse({ success: false, error: 'Rejected unsafe headers: ' + bad.join('; ') });
          break;
        }

        // Apply to the single active config (one-click UX): replace its headers
        // and enable. Only reached after the S3 validation gate above.
        let configs = this.configService.getAllConfigs();
        if (!configs || configs.length === 0) {
          await this.configService.addConfig({ name: 'Default', enabled: false, headers: [], scope: { type: 'all', value: '' } });
          configs = this.configService.getAllConfigs();
        }
        const first = configs[0];
        const updated = await this.configService.updateConfig(first.id, { headers: candidate, enabled: true });
        try { await this.configService.updateNetworkRules(); } catch (_) {}
        await this.updateActionState();
        sendResponse({ success: true, data: updated });
        break;
      }

      default:
        sendResponse({
          success: false,
          error: `Unknown action: ${action}`
        });
      }

    } catch (error) {
      console.error('Handle message failed:', error);
      sendResponse({
        success: false,
        error: error.message
      });
    }
  }

  // On configs changed
  async handleConfigsChanged() {
    try {
      // reload configs
      await this.configService.loadConfigs();
      // sync rules
      try {
        await this.configService.updateNetworkRules();
      } catch (e) {
        console.warn('Rule update after change failed:', e?.message || e);
      }
      await this.updateActionState();
    } catch (error) {
      console.error('Handle config change failed:', error);
    }
  }

  // Badge: how many URL-pattern tabs match this browser address
  updateBadgeForTab(tab) {
    if (!tab?.id || !tab.url) return;
    const matchingConfigs = this.configService.getEnabledConfigs().filter(config => {
      return this.configService.isUrlMatchingScope(tab.url, config.scope);
    });
    this.updateBadge(tab.id, matchingConfigs.length);
  }

  // Badge
  updateBadge(tabId, count) {
    if (count > 0) {
      chrome.action.setBadgeText({
        text: count.toString(),
        tabId: tabId
      });
      chrome.action.setBadgeBackgroundColor({
        color: '#4CAF50',
        tabId: tabId
      });
    } else {
      chrome.action.setBadgeText({
        text: '',
        tabId: tabId
      });
    }
  }

  // Update toolbar icon and title to reflect active/paused state
  async updateActionState() {
    try {
      const configs = this.configService.getAllConfigs();
      const enabledHeadersCount = configs
        .filter(c => c.enabled)
        .flatMap(c => c.headers || [])
        .filter(h => h && h.enabled !== false && (h.name || '').trim()).length;

      const isActive = enabledHeadersCount > 0;
      const title = isActive
        ? `VibeHeader — Active (${enabledHeadersCount} headers)`
        : 'VibeHeader — Ready (add a header)';
      await chrome.action.setTitle({ title });

      const basePath = 'icons';
      const paths = isActive
        ? { 16: `${basePath}/icon16.png`, 32: `${basePath}/icon32.png`, 48: `${basePath}/icon48.png`, 128: `${basePath}/icon128.png` }
        : { 16: `${basePath}/icon16_gray.png`, 32: `${basePath}/icon32_gray.png`, 48: `${basePath}/icon48_gray.png`, 128: `${basePath}/icon128_gray.png` };
      await chrome.action.setIcon({ path: paths });
    } catch (e) {
      console.warn('updateActionState failed:', e?.message || e);
    }
  }
}

// Create and initialize the background service
const backgroundService = new BackgroundService();
backgroundService.init();
