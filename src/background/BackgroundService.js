import { ConfigService } from '../shared/services/ConfigService.js';
import { ValidationUtils } from '../shared/utils/validation.js';
import {
  normalizeRequestMatch,
  RequestFilterLimits,
  serializedUtf8Size
} from '../shared/utils/requestFilters.js';

// Background Service Worker
export class BackgroundService {
  constructor(configService = new ConfigService()) {
    this.configService = configService;
    this.isInitialized = false;
    this.readyPromise = null;
    this._configTaskTail = Promise.resolve();
  }

  enqueueConfigTask(task) {
    const result = this._configTaskTail.then(task);
    this._configTaskTail = result.catch(() => {});
    return result;
  }

  serializeProfile(profile) {
    const canonical = typeof profile?.toJSON === 'function'
      ? profile.toJSON()
      : { ...(profile || {}) };
    return {
      ...canonical,
      // Keep the popup message boundary compatible during the schema
      // migration. Storage remains canonical and never writes these aliases.
      enabled: typeof profile?.enabled === 'boolean'
        ? profile.enabled
        : !!canonical.active,
      headers: Array.isArray(profile?.headers)
        ? profile.headers.map(header => ({ ...header }))
        : [],
      filters: Array.isArray(profile?.filters)
        ? profile.filters.map(filter => ({ ...filter }))
        : []
    };
  }

  serializeProfileState(state) {
    return {
      ...state,
      profiles: (state?.profiles || []).map(profile =>
        this.serializeProfile(profile)
      )
    };
  }

  // Init
  async init() {
    try {
      // Register listeners synchronously. A Manifest V3 worker can be started
      // by the very message it needs to handle; waiting for storage first
      // creates a window where Chrome sees no receiving end.
      this.readyPromise = this.configService.init();
      this.setupEventListeners();
      await this.readyPromise;
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
        this.enqueueConfigTask(() => this.handleConfigsChanged())
          .catch(error => console.error('Handle config change failed:', error));
      }
    });

  }

  // Install/update
  async handleInstall(details) {
    if (this.readyPromise) {
      await this.readyPromise.catch(() => {});
    }
    if (details.reason === 'install') {
      console.log('VibeHeader first install');
      // create default config
      try {
        await this.enqueueConfigTask(() => this.createDefaultConfig());
      } catch (error) {
        console.error('Failed to create default config:', error);
      }

    } else if (details.reason === 'update') {
      console.log('VibeHeader updated to version:', chrome.runtime.getManifest().version);
    }
  }

  // Default config
  async createDefaultConfig() {
    const defaultConfig = {
      name: 'Default',
      active: false,
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
      case 'getConfigs': {
        const configs = await this.enqueueConfigTask(() => this.configService.getAllConfigs());
        sendResponse({
          success: true,
          data: configs.map(config => this.serializeProfile(config))
        });
        break;
      }

      case 'getProfileState': {
        const state = await this.enqueueConfigTask(() => this.configService.getProfileState());
        sendResponse({
          success: true,
          data: this.serializeProfileState(state)
        });
        break;
      }

      case 'addConfig': {
        const newConfig = await this.enqueueConfigTask(async () => {
          const added = await this.configService.addConfig(data);
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          return added;
        });
        sendResponse({
          success: true,
          data: this.serializeProfile(newConfig)
        });
        break;
      }

      case 'updateConfig': {
        const updatedConfig = await this.enqueueConfigTask(async () => {
          const updated = await this.configService.updateConfig(data.id, data.config);
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          return updated;
        });
        sendResponse({
          success: true,
          data: this.serializeProfile(updatedConfig)
        });
        break;
      }

      case 'toggleConfig': {
        const toggledConfig = await this.enqueueConfigTask(async () => {
          const toggled = await this.configService.toggleConfig(data.id, data.enabled);
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          return toggled;
        });
        sendResponse({
          success: true,
          data: this.serializeProfile(toggledConfig)
        });
        break;
      }

      case 'createProfile': {
        const profile = await this.enqueueConfigTask(async () => {
          const created = await this.configService.createProfile();
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          return created;
        });
        sendResponse({ success: true, data: this.serializeProfile(profile) });
        break;
      }

      case 'duplicateProfile': {
        const profile = await this.enqueueConfigTask(async () => {
          const duplicate = await this.configService.duplicateConfig(data.id);
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          return duplicate;
        });
        sendResponse({ success: true, data: this.serializeProfile(profile) });
        break;
      }

      case 'deleteProfile': {
        const deleted = await this.enqueueConfigTask(async () => {
          const removed = await this.configService.deleteConfig(data.id);
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          return removed;
        });
        sendResponse({
          success: true,
          data: {
            deletedId: deleted.id,
            state: this.serializeProfileState(this.configService.getProfileState())
          }
        });
        break;
      }

      case 'selectProfile': {
        const state = await this.enqueueConfigTask(() =>
          this.configService.selectProfile(data.id)
        );
        sendResponse({
          success: true,
          data: this.serializeProfileState(state)
        });
        break;
      }

      case 'importSharedKV': {
        this.assertSharedPayloadSize(data);
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
          if (ValidationUtils.validateHeaderName(h.name).length) {
            bad.push(`#${i + 1} "${h.name}": invalid header name`);
          }
          const valErrs = ValidationUtils.validateHeaderValue(h.value);
          if (valErrs.length) bad.push(`#${i + 1} "${h.name}": ${valErrs.join(', ')}`);
        });
        if (bad.length) {
          sendResponse({ success: false, error: 'Rejected unsafe headers: ' + bad.join('; ') });
          break;
        }

        const imported = await this.enqueueConfigTask(async () => {
          const result = await this.configService.importConfig({
            name: this.importedProfileName(data?.name),
            active: true,
            headers: candidate,
            scope: { type: 'all', value: '' }
          });
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          if (result.id) await this.configService.selectProfile(result.id);
          return result;
        });
        sendResponse({ success: true, data: this.serializeProfile(imported) });
        await this.openPopupAfterImport();
        break;
      }

      case 'importSharedProfile': {
        const imported = await this.importSharedProfile(data);
        sendResponse({ success: true, data: this.serializeProfile(imported) });
        await this.openPopupAfterImport();
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

  importedProfileName(suggestedName) {
    const base = String(suggestedName || '').trim();
    const replaceableId =
      this.configService.replaceableEmptyProfile?.()?.id;
    const names = new Set(
      this.configService.getAllConfigs()
        .filter(profile => !replaceableId || profile?.id !== replaceableId)
        .map(profile => String(profile?.name || '').trim().toLowerCase())
        .filter(Boolean)
    );

    const nextDefaultName = () => {
      let index = 1;
      while (names.has(`profile ${index}`)) index += 1;
      return `Profile ${index}`;
    };

    if (!base) return nextDefaultName();
    if (!names.has(base.toLowerCase())) return base;

    // Avoid awkward names such as "Profile 1 2". A shared default name joins
    // the same sequence used when creating a Profile locally.
    if (/^profile \d+$/i.test(base)) return nextDefaultName();

    let index = 2;
    while (names.has(`${base} ${index}`.toLowerCase())) index += 1;
    return `${base} ${index}`;
  }

  async openPopupAfterImport() {
    const openPopup = globalThis.chrome?.action?.openPopup;
    if (typeof openPopup !== 'function') return false;
    try {
      await openPopup.call(globalThis.chrome.action);
      return true;
    } catch (error) {
      console.warn('Imported Profile, but could not open popup:', error?.message || error);
      return false;
    }
  }

  assertSharedPayloadSize(data) {
    if (serializedUtf8Size(data || {}) > RequestFilterLimits.MAX_SHARED_PROFILE_BYTES) {
      throw new Error(
        `Shared Profile must be ${RequestFilterLimits.MAX_SHARED_PROFILE_BYTES / 1024}KB or smaller`
      );
    }
  }

  async importSharedProfile(data) {
    this.assertSharedPayloadSize(data);
    const compact = data?.v === 2 && Array.isArray(data?.h);
    const profile = compact ? null : (data?.profile || {});
    const rawHeaders = compact
      ? data.h.map(header => Array.isArray(header)
        ? { name: header[0], value: header[1], enabled: true }
        : header)
      : (Array.isArray(profile.headers) ? profile.headers : []);
    const headers = rawHeaders
      .filter(header => String(header?.name || '').trim())
      .map(header => ({
        name: String(header.name).trim(),
        value: String(header.value ?? ''),
        enabled: header.enabled !== false,
        type: 'request'
      }));

    if (!headers.length) throw new Error('No valid headers in shared Profile');
    headers.forEach(header => {
      if (ValidationUtils.validateHeaderName(header.name).length) {
        throw new Error(`Invalid header name: ${header.name}`);
      }
      const errors = ValidationUtils.validateHeaderValue(header.value);
      if (errors.length) throw new Error(errors.join(', '));
    });

    let filters;
    if (compact) {
      filters = (Array.isArray(data.f) ? data.f : []).map(filter =>
        normalizeRequestMatch(Array.isArray(filter)
          ? {
            expression: String(filter[0] || ''),
            enabled: filter[1] !== false
          }
          : {
            expression: String(filter?.expression || ''),
            enabled: filter?.enabled !== false
          })
      );
    } else {
      const scope = profile.requestScope || { type: 'allRequests', filters: [] };
      if (!['allRequests', 'filtered', 'noUrls'].includes(scope.type)) {
        throw new Error('Invalid request scope');
      }
      filters = ['filtered', 'noUrls'].includes(scope.type)
        ? (Array.isArray(scope.filters) ? scope.filters : []).map(filter =>
          normalizeRequestMatch({
            expression: String(filter?.expression || ''),
            enabled: filter?.enabled !== false
          })
        )
        : [];
      if (scope.type !== 'allRequests' && !filters.length) {
        throw new Error('Filtered Profile must include at least one filter');
      }
    }
    const invalidFilter = filters.find(filter => !filter.validation?.valid);
    if (invalidFilter) {
      throw new Error(invalidFilter.validation?.reason || 'Invalid request filter');
    }
    if (filters.length > RequestFilterLimits.MAX_FILTERS_PER_PROFILE) {
      throw new Error(
        `A Profile can use up to ${RequestFilterLimits.MAX_FILTERS_PER_PROFILE} filters`
      );
    }
    await this.configService.assertRequestMatchesSupported?.(filters);

    return this.enqueueConfigTask(async () => {
      const imported = await this.configService.importConfig({
        name: this.importedProfileName(compact ? data.n : profile.suggestedName),
        active: true,
        headers,
        filters
      });
      await this.configService.updateNetworkRules();
      await this.updateActionState();
      if (imported.id) await this.configService.selectProfile(imported.id);
      return imported;
    });
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

  // Update toolbar icon and title to reflect active/paused state
  async updateActionState() {
    try {
      const configs = this.configService.getAllConfigs();
      const enabledHeadersCount = configs
        .filter(c => c.active)
        .flatMap(c => c.headers || [])
        .filter(h =>
          h
          && h.enabled !== false
          && !ValidationUtils.validateHeaderName(h.name).length
          && !ValidationUtils.validateHeaderValue(h.value).length
        ).length;

      const isActive = enabledHeadersCount > 0;
      const title = isActive
        ? `VibeHeader — Active (${enabledHeadersCount} headers)`
        : 'VibeHeader — Ready (add a header)';
      await chrome.action.setBadgeText({ text: '' });
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
