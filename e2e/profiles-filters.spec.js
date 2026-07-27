const http = require('node:http');
const path = require('node:path');
const { configBarrier, expect, test } = require('./fixtures');

let echoServer;
let echoOrigin;

test.beforeAll(async () => {
  echoServer = http.createServer((request, response) => {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json'
    });
    response.end(JSON.stringify({ headers: request.headers }));
  });
  await new Promise((resolve, reject) => {
    echoServer.once('error', reject);
    echoServer.listen(0, '127.0.0.1', resolve);
  });
  echoOrigin = `http://127.0.0.1:${echoServer.address().port}`;
});

test.afterAll(async () => {
  if (!echoServer) return;
  await new Promise((resolve, reject) => {
    echoServer.close(error => error ? reject(error) : resolve());
  });
});

test('keeps an unsafe Filter as a draft while applying to all requests', async ({
  context,
  openPopup
}) => {
  const popup = await openPopup();
  await popup.locator('.vh-h-name').fill('X-Filter-Safety');
  await popup.locator('.vh-h-value').fill('protected');
  await popup.locator('#addFilterBtn').click();

  const filterInput = popup.locator('.vh-filter-value');
  const filterError = popup.locator('.vh-filter-error');
  const rejectedExpressions = [
    {
      expression: '(a+)+$',
      reason: 'Regex contains a repeated nested pattern'
    },
    {
      expression: '^(a|aa)+$',
      reason: 'Regex contains an ambiguous repeated alternative'
    },
    {
      expression: '^(a{1,100}){1,100}$',
      reason: 'Regex contains a repeated nested pattern'
    }
  ];
  for (const rejected of rejectedExpressions) {
    await filterInput.fill(rejected.expression);
    await expect(filterInput).toBeFocused();
    await expect(filterInput).toHaveValue(rejected.expression);
    await expect(filterInput).toHaveAttribute('aria-invalid', 'true');
    await expect(filterInput).toHaveCSS('border-color', 'rgb(239, 68, 68)');
    await expect(filterError).toBeVisible();
    await expect(filterError).toHaveText(rejected.reason);
  }
  await expect(filterInput).toHaveAttribute(
    'aria-describedby',
    await filterError.getAttribute('id')
  );
  await configBarrier(popup);

  let safetyRules = await popup.evaluate(async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.filter(rule =>
      (rule.action.requestHeaders || []).some(header =>
        header.header.toLowerCase() === 'x-filter-safety'
      )
    );
  });
  expect(safetyRules).toHaveLength(1);
  expect(safetyRules[0].condition).not.toHaveProperty('regexFilter');

  const requestPage = await context.newPage();
  let response = await requestPage.goto(`${echoOrigin}/unsafe-filter`);
  let body = await response.json();
  expect(body.headers['x-filter-safety']).toBe('protected');

  await filterInput.fill(`${echoOrigin}/safe*`);
  await expect(filterInput).toBeFocused();
  await expect(filterInput).toHaveAttribute('aria-invalid', 'false');
  await expect(filterError).toBeHidden();
  await configBarrier(popup);

  safetyRules = await popup.evaluate(async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.filter(rule =>
      (rule.action.requestHeaders || []).some(header =>
        header.header.toLowerCase() === 'x-filter-safety'
      )
    );
  });
  expect(safetyRules).toHaveLength(1);

  response = await requestPage.goto(`${echoOrigin}/safe-path`);
  body = await response.json();
  expect(body.headers['x-filter-safety']).toBe('protected');

  response = await requestPage.goto(`${echoOrigin}/outside`);
  body = await response.json();
  expect(body.headers['x-filter-safety']).toBeUndefined();
});

test('runs multiple Profiles and limits one Profile with a Filter', async ({
  context,
  openPopup
}) => {
  const popup = await openPopup();
  const pageErrors = [];
  popup.on('pageerror', error => pageErrors.push(error.message));

  await popup.locator('.vh-h-name').fill('X-Profile-One');
  await popup.locator('.vh-h-value').fill('one');
  await configBarrier(popup);

  await popup.locator('#profileTrigger').click();
  await popup.locator('.vh-new-profile').click();
  await expect(popup.locator('#profileRenameInput')).toBeVisible();
  await popup.locator('#profileRenameInput').fill('VibeHeader Production');
  await popup.locator('#profileRenameSave').click();

  await popup.locator('.vh-h-name').fill('X-Profile-Two');
  await popup.locator('.vh-h-value').fill('two');
  const profileNameLayout = await popup.locator('#profileName').evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  expect(profileNameLayout.scrollWidth).toBeLessThanOrEqual(
    profileNameLayout.clientWidth
  );
  const headerGap = await popup.evaluate(() => {
    const identity = document.querySelector('.vh-identity').getBoundingClientRect();
    const actions = document.querySelector('.vh-header-actions').getBoundingClientRect();
    return actions.left - identity.right;
  });
  expect(headerGap).toBeGreaterThanOrEqual(12);
  await popup.locator('#addFilterBtn').click();
  await expect(popup.locator('#filtersPanel')).toBeVisible();
  const filterInput = popup.locator('.vh-filter-value');
  await expect(filterInput).toBeFocused();
  await filterInput.pressSequentially(`${echoOrigin}/matched*`);
  await expect(filterInput).toBeFocused();
  await configBarrier(popup);

  await popup.locator('.vh-h-name').fill('X-Profile-One');
  await configBarrier(popup);
  await popup.locator('#profileTrigger').click();
  await popup.locator('.vh-profile-select').first().click();
  await expect(popup.locator('.vh-header-override'))
    .toHaveText('Overridden by “VibeHeader Production” on matching requests');
  await expect(popup.locator('.vh-header-row')).toHaveClass(/is-overridden/);
  await expect(popup.locator('.vh-h-value'))
    .toHaveCSS('border-color', 'rgb(252, 165, 165)');

  await popup.locator('#profileTrigger').click();
  await popup.locator('.vh-profile-select').last().click();
  await popup.locator('.vh-h-name').fill('X-Profile-Two');
  await configBarrier(popup);

  await popup.locator('#filtersSummary').click();
  await popup.locator('.vh-h-value').click();
  await expect(filterInput).toHaveValue(`${echoOrigin}/matched*`);
  const controlCenters = await popup.evaluate(() => {
    const chevron = document.querySelector('#filtersSummary .vh-chevron')
      .getBoundingClientRect();
    const remove = document.querySelector('.vh-del-filter')
      .getBoundingClientRect();
    return {
      chevron: chevron.left + chevron.width / 2,
      remove: remove.left + remove.width / 2
    };
  });
  expect(Math.abs(controlCenters.chevron - controlCenters.remove)).toBeLessThan(0.5);
  await expect(popup.locator('#testUrlBtn')).toHaveText('Test a URL');
  await expect(popup.locator('#filtersSummary')).not.toContainText('No tab URL');
  await popup.locator('#testUrlBtn').click();
  await expect(popup.locator('#urlTester')).toBeVisible();
  await expect(popup.locator('#urlTesterDone')).toHaveAttribute(
    'aria-label',
    'Close URL test'
  );
  const inputStyles = await popup.evaluate(() => {
    const read = selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        color: style.color,
        height: style.height,
        borderRadius: style.borderRadius
      };
    };
    return {
      header: read('.vh-h-name'),
      filter: read('.vh-filter-value'),
      tester: read('#urlTesterInput')
    };
  });
  expect(inputStyles.filter).toEqual(inputStyles.header);
  expect(inputStyles.tester).toEqual(inputStyles.header);
  await popup.locator('#urlTesterDone').click();
  await expect(popup.locator('#urlTester')).toBeHidden();
  await expect(popup.locator('#testUrlBtn')).toBeVisible();
  await expect(popup.locator('#testUrlBtn')).toBeFocused();

  const profiles = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'getConfigs' });
    return response.data;
  });
  expect(profiles).toHaveLength(2);
  expect(profiles.every(profile => profile.active)).toBe(true);
  expect(profiles[1].rules[0].requestMatches[0].expression)
    .toBe(`${echoOrigin}/matched*`);
  expect(profiles[1].rules[0].actions[0].type).toBe('requestHeader');
  const badgeText = await popup.evaluate(() => chrome.action.getBadgeText({}));
  expect(badgeText).toBe('');

  const requestPage = await context.newPage();
  let response = await requestPage.goto(`${echoOrigin}/matched`);
  let body = await response.json();
  expect(body.headers['x-profile-one']).toBe('one');
  expect(body.headers['x-profile-two']).toBe('two');

  response = await requestPage.goto(`${echoOrigin}/outside`);
  body = await response.json();
  expect(body.headers['x-profile-one']).toBe('one');
  expect(body.headers['x-profile-two']).toBeUndefined();

  const deleteVisibility = await popup.locator('.vh-del').evaluateAll(buttons =>
    buttons.map(button => getComputedStyle(button).opacity)
  );
  expect(deleteVisibility.every(opacity => opacity === '1')).toBe(true);
  await popup.locator('#app').screenshot({
    path: path.join('test-results', 'vibeheader-filter-view.png')
  });

  await popup.locator('#toggleBtn').click();
  await expect(popup.locator('#pauseBannerText'))
    .toHaveText('Paused. 1 other profile is still active.');
  await expect(popup.locator('#filtersSummary')).toHaveAttribute('aria-expanded', 'false');
  await expect(popup.locator('#filtersPanel')).toBeHidden();
  await expect(popup.locator('#filtersSummary .vh-filter-summary-value'))
    .toHaveCSS('color', 'rgb(107, 114, 128)');
  await expect(popup.locator('#filtersSummary .vh-tag-paused')).toHaveText('Paused');
  await expect(popup.locator('#filtersSummary .vh-tag-paused i')).toHaveCount(0);
  await expect(popup.locator('#filtersSummary .vh-tag-paused'))
    .toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const pausedControlStyles = await popup.evaluate(() => {
    const chevron = getComputedStyle(
      document.querySelector('#filtersSummary .vh-chevron')
    );
    const remove = getComputedStyle(document.querySelector('.vh-del-header'));
    return {
      chevronColor: chevron.color,
      chevronOpacity: chevron.opacity,
      removeColor: remove.color,
      removeOpacity: remove.opacity
    };
  });
  expect(pausedControlStyles.chevronColor).toBe(pausedControlStyles.removeColor);
  expect(pausedControlStyles.chevronOpacity).toBe(pausedControlStyles.removeOpacity);
  await configBarrier(popup);
  response = await requestPage.goto(`${echoOrigin}/matched?paused=1`);
  body = await response.json();
  expect(body.headers['x-profile-one']).toBe('one');
  expect(body.headers['x-profile-two']).toBeUndefined();

  await popup.locator('#toggleBtn').click();
  await expect(popup.locator('#filtersPanel')).toBeHidden();
  await popup.locator('#filtersSummary').click();
  await expect(popup.locator('#filtersPanel')).toBeVisible();
  await popup.locator('.vh-del-filter').click();
  await expect(popup.locator('.vh-overlay')).toHaveCount(0);
  await expect(popup.locator('#filtersSection')).toBeHidden();
  await configBarrier(popup);
  response = await requestPage.goto(`${echoOrigin}/outside?filter=deleted`);
  body = await response.json();
  expect(body.headers['x-profile-two']).toBe('two');

  await popup.locator('#toggleBtn').click();
  await configBarrier(popup);

  await popup.locator('#profileTrigger').click();
  await expect(popup.locator('.vh-profile-row')).toHaveCount(2);
  await expect(popup.locator('.vh-menu-heading')).toHaveText('Profiles');
  await expect(popup.locator('.vh-menu-heading kbd')).toHaveCount(0);
  await expect(popup.locator('.vh-new-profile')).toHaveText('Add profile');
  const selectedMarker = await popup.locator('.vh-profile-row.is-selected .vh-profile-row-name')
    .evaluate(element => getComputedStyle(element, '::after').content);
  expect(selectedMarker).toBe('none');
  await popup.locator('.vh-profile-rename').first().click();
  await expect(popup.locator('.vh-profile-row.is-renaming .vh-rename-input'))
    .toBeFocused();
  await popup.keyboard.press('Escape');
  const profileActionVisibility = await popup
    .locator('.vh-profile-icon')
    .evaluateAll(buttons => buttons.map(button => getComputedStyle(button).opacity));
  expect(profileActionVisibility.every(opacity => Number(opacity) > 0)).toBe(true);
  await expect(popup.locator('[aria-label="Pause all"]')).toHaveCount(0);
  const menuHeightBeforePopover = await popup.locator('#profileMenu')
    .evaluate(element => element.getBoundingClientRect().height);
  await popup.locator('.vh-profile-more').first().click();
  await expect(popup.locator('.vh-row-menu')).toBeVisible();
  await expect(popup.locator('.vh-row-menu')).toHaveCSS('position', 'absolute');
  const menuHeightAfterPopover = await popup.locator('#profileMenu')
    .evaluate(element => element.getBoundingClientRect().height);
  expect(menuHeightAfterPopover).toBe(menuHeightBeforePopover);
  await popup.screenshot({
    path: path.join('test-results', 'vibeheader-profile-menu.png'),
    clip: { x: 0, y: 0, width: 480, height: 300 }
  });
  await popup.locator('.vh-copy-profile').click();
  await expect(popup.locator('#profileMenu')).toBeHidden();
  await expect(popup.locator('#toast')).toHaveCount(0);

  await popup.locator('#profileTrigger').click();
  await popup.locator('.vh-profile-more').first().click();
  await popup.locator('.vh-delete-profile').click();
  await expect(popup.locator('.vh-overlay')).toBeVisible();
  const dialogGeometry = await popup.evaluate(() => {
    const overlay = document.querySelector('.vh-overlay').getBoundingClientRect();
    const modal = document.querySelector('.vh-modal').getBoundingClientRect();
    return {
      overlay: {
        top: overlay.top,
        left: overlay.left,
        width: overlay.width,
        height: overlay.height
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      modalCenter: {
        x: modal.left + modal.width / 2,
        y: modal.top + modal.height / 2
      }
    };
  });
  expect(dialogGeometry.overlay).toEqual({
    top: 0,
    left: 0,
    width: dialogGeometry.viewport.width,
    height: dialogGeometry.viewport.height
  });
  expect(dialogGeometry.modalCenter.x)
    .toBeCloseTo(dialogGeometry.viewport.width / 2, 0);
  expect(dialogGeometry.modalCenter.y)
    .toBeCloseTo(dialogGeometry.viewport.height / 2, 0);
  await popup.locator('[data-action="cancel"]').click();
  expect(pageErrors).toEqual([]);
});
