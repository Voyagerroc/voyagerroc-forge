// Optional acceptance runner. Set PLAYWRIGHT_MODULE to a local Playwright package path.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const fs = require('node:fs');
(async () => {
  fs.mkdirSync('qa', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4317');
    await page.locator('#repository').fill('GoogleCloudPlatform/scion');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'GitHub repository connected.' }).waitFor({ timeout: 30000 });
    await page.locator('#new-task').click();
    await page.locator('#title').fill('Demo: validate the GitHub-connected workflow');
    await page.locator('#intent').fill('Acceptance walkthrough only. Generate a plan, request review and approve the specification. Do not execute agents or modify the upstream repository.');
    await page.getByRole('button', { name: 'Create task', exact: true }).click();
    await page.getByRole('button', { name: 'Generate plan', exact: true }).first().click();
    await page.getByRole('button', { name: 'Request review', exact: true }).first().click();
    await page.getByRole('button', { name: 'Approve plan', exact: true }).first().click();
    await page.getByText('Plan approved · execution not started', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'View plan', exact: true }).first().click();
    await page.getByText('DRY RUN · No agent execution', { exact: true }).waitFor();
    await page.locator('#close-plan').click();
    await page.reload();
    await page.getByText('Plan approved · execution not started', { exact: true }).first().waitFor();
    await page.screenshot({ path: 'qa/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.screenshot({ path: 'qa/mobile.png', fullPage: true });
    const result = { actualGitHubRepository: 'GoogleCloudPlatform/scion', persistedApproval: true, mobileOverflow: overflow, pageErrors: errors };
    fs.writeFileSync('qa/browser-result.json', JSON.stringify(result, null, 2));
    if (overflow || errors.length) throw new Error(JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
