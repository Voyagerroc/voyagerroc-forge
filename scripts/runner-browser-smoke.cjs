const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const fs = require('node:fs');
const assert = require('node:assert/strict');

async function checkLimits(page, runner) {
  const { snapshot, edits } = runner.limits;
  const bytes = value => value >= 1024 * 1024 ? `${value / (1024 * 1024)} MiB` : `${value / 1024} KiB`;
  const banner = await page.locator('#runner-limits').innerText();
  for (const text of [`${snapshot.minFiles}–${snapshot.maxFiles} regular tracked files`,
    `${bytes(snapshot.maxFileBytes)} per file`, `${bytes(snapshot.maxBytes)} total`,
    `${edits.minCount}–${edits.maxCount} files`, `${bytes(edits.maxTextBytes)} of UTF-8 text`,
    'all before and after strings combined', `${runner.timeoutMs / 1000} seconds`]) assert.ok(banner.includes(text), text);
  const scope = await page.locator('#run-check-scope').innerText();
  for (const text of ['Static checks only', 'edited files', '.json', '.js/.mjs/.cjs', 'diff whitespace', 'No AI generation or project tests'])
    assert.ok(scope.includes(text), text);
  assert.equal(await page.locator('#edits').getAttribute('aria-describedby'), 'runner-limits run-check-scope');
  assert.equal(await page.getByRole('dialog', { name: 'Run scoped edits', exact: true }).count(), 1);
  assert.equal(await page.locator('#run-dialog').evaluate(el => el.scrollWidth > el.clientWidth), false);
}

(async () => {
  fs.mkdirSync('qa', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const origin = process.env.FORGE_URL || 'http://127.0.0.1:4317';
    await page.goto(origin);
    await page.locator('#new-task').click();
    const state = await (await page.request.get(origin + '/api/state')).json();
    const project = state.projects.find(p => p.full_name === 'local/runner-demo');
    if (!project) throw new Error('Start npm run demo:runner first');
    await page.locator('#project').selectOption(project.id);
    const title = `Runner acceptance ${Date.now()}`;
    await page.locator('#title').fill(title);
    await page.locator('#intent').fill('Apply an explicit spelling correction in a separate copy and inspect the real patch plus static verification evidence.');
    await page.getByRole('button', { name: 'Create task', exact: true }).click();
    const card = page.locator('.task-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    for (const action of ['Generate plan', 'Request review', 'Approve plan']) await card.getByRole('button', { name: action, exact: true }).click();
    const start = card.getByRole('button', { name: 'Run scoped edits', exact: true });
    await start.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole('button', { name: 'View plan', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await start.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await checkLimits(page, state.runner);
    assert.equal(await page.locator('#close-run').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#edits').evaluate(el => el === document.activeElement), true);
    const focusOutline = await page.locator('#edits').evaluate(el => getComputedStyle(el).outlineStyle);
    assert.notEqual(focusOutline, 'none');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#close-run').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await start.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#run-dialog').evaluate(el => el.open), false);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.screenshot({ path: 'qa/forge-runner-limits-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await checkLimits(page, state.runner);
    await page.screenshot({ path: 'qa/forge-runner-limits-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#edits').fill(JSON.stringify([{ path: 'hello.mjs', before: '"helo"', after: '"hello"' }], null, 2));
    await page.keyboard.press('Tab');
    const submit = page.getByRole('button', { name: 'Run edits & static checks', exact: true });
    assert.equal(await submit.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    const result = page.locator('.run-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await result.getByText('passed', { exact: true }).waitFor({ timeout: 30000 });
    await result.getByRole('button', { name: 'View evidence', exact: true }).click();
    await page.locator('#run-detail pre').filter({ hasText: '+export const greeting = "hello";' }).waitFor();
    if (!(await page.locator('#run-detail').innerText()).includes('syntax:hello.mjs')) throw new Error('No real syntax evidence');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'qa/forge-runner-evidence-desktop-2026-10-28.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const modalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.screenshot({ path: 'qa/forge-runner-evidence-mobile-2026-10-28.png', fullPage: true });
    await page.locator('#close-result').click();
    await page.reload();
    await page.locator('.run-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByText('passed', { exact: true }).waitFor();
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    const saved = await (await page.request.get(origin + '/api/state')).json();
    const task = saved.tasks.find(t => t.title === title); const run = saved.runs.find(r => r.task_id === task.id);

    // Substitute only capability metadata to catch hard-coded UI limits.
    const fixtureRunner = { ...saved.runner, timeoutMs: 9000, limits: {
      snapshot: { minFiles: 2, maxFiles: 17, maxFileBytes: 512 * 1024, maxBytes: 3 * 1024 * 1024 },
      edits: { minCount: 2, maxCount: 7, maxTextBytes: 32 * 1024 }
    } };
    await page.route('**/api/state', async route => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, runner: fixtureRunner } });
    });
    await page.reload();
    await start.focus();
    await page.keyboard.press('Enter');
    await checkLimits(page, fixtureRunner);
    await page.keyboard.press('Escape');
    await page.unroute('**/api/state');
    assert.equal((await (await page.request.get(origin + '/api/state')).json()).runs.length, saved.runs.length);
    const report = { persisted: run.status === 'passed', baseSha: run.base_sha, patchSha256: run.patch_sha256,
      checks: run.checks.map(c => ({ name: c.name, status: c.status })), modalOverflow, pageOverflow, pageErrors: errors,
      capabilityMetadata: true, substitutedCapabilities: true, keyboardNavigation: true, keyboardSubmission: true,
      mobileViewport: { width: 390, height: 844 }, browser: browser.version() };
    fs.writeFileSync('qa/forge-runner-browser-result-2026-10-28.json', JSON.stringify(report, null, 2));
    if (modalOverflow || pageOverflow || errors.length) throw new Error(JSON.stringify(report));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
