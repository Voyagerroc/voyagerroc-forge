const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const fs = require('node:fs');
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
    for (const action of ['Generate plan', 'Request review', 'Approve plan', 'Run scoped edits']) await card.getByRole('button', { name: action, exact: true }).click();
    await page.locator('#edits').fill(JSON.stringify([{ path: 'hello.mjs', before: '"helo"', after: '"hello"' }], null, 2));
    await page.getByRole('button', { name: 'Run edits & static checks', exact: true }).click();
    const result = page.locator('.run-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await result.getByText('passed', { exact: true }).waitFor({ timeout: 30000 });
    await result.getByRole('button', { name: 'View evidence', exact: true }).click();
    await page.locator('#run-detail pre').filter({ hasText: '+export const greeting = "hello";' }).waitFor();
    if (!(await page.locator('#run-detail').innerText()).includes('syntax:hello.mjs')) throw new Error('No real syntax evidence');
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
    const report = { persisted: run.status === 'passed', baseSha: run.base_sha, patchSha256: run.patch_sha256,
      checks: run.checks.map(c => ({ name: c.name, status: c.status })), modalOverflow, pageOverflow, pageErrors: errors };
    fs.writeFileSync('qa/forge-runner-browser-result-2026-10-28.json', JSON.stringify(report, null, 2));
    if (modalOverflow || pageOverflow || errors.length) throw new Error(JSON.stringify(report));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
