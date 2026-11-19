// Optional keyboard acceptance check against the local demo; see docs/DEVELOPMENT.md.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  fs.mkdirSync('qa', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = { browser: browser.version(), viewports: [], pageErrors: [] };
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.on('pageerror', error => report.pageErrors.push(error.message));
      const origin = process.env.FORGE_URL || 'http://127.0.0.1:4317';
      await page.goto(origin);
      await page.waitForFunction(() => !document.querySelector('#new-task').disabled);
      const snapshot = await (await page.request.get(`${origin}/api/state`)).json();
      assert.equal(snapshot.projects[0]?.full_name, 'local/runner-demo', 'Start a fresh demo database first');

      // Focus and activate controls exclusively through keyboard input.
      async function tabTo(locator, key = 'Tab') {
        for (let i = 0; i < 200; i++) {
          if (await locator.evaluate(el => el === document.activeElement)) return;
          await page.keyboard.press(key);
        }
        throw new Error(`Keyboard could not reach ${locator}`);
      }
      async function activate(locator) {
        await tabTo(locator);
        await page.keyboard.press('Enter');
      }
      async function focused(locator) {
        await page.waitForFunction(el => el?.isConnected && el === document.activeElement, await locator.elementHandle());
        const outline = await locator.evaluate(el => {
          const style = getComputedStyle(el), rect = el.getBoundingClientRect();
          return { id: el.id, rect: rect.toJSON(), visible: el.matches(':focus-visible'), style: style.outlineStyle, width: parseFloat(style.outlineWidth),
            inViewport: rect.left >= 3 && rect.right <= innerWidth - 3 && rect.top >= 3 && rect.bottom <= innerHeight - 3 };
        });
        assert.ok(outline.visible && outline.style !== 'none' && outline.width > 0 && outline.inViewport, JSON.stringify(outline));
      }
      async function fits(dialog) {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page overflow');
        if (dialog) assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false, 'Dialog overflow');
      }
      // The visible heading is the accessible name; a screen reader announces e.g.
      // "Create a task, dialog" and a role-based locator can find it. The plan dialog's
      // title names the task, so it is matched by prefix.
      const dialogNames = {
        task: 'Create a task',
        plan: /^Plan for /,
        run: 'Run scoped edits',
      };
      async function open(trigger, id) {
        await activate(trigger);
        // Find the dialog by role and accessible name, not by CSS id, so a missing
        // aria-labelledby (or a stale heading) fails here instead of at review time.
        const dialog = page.getByRole('dialog', { name: dialogNames[id], exact: true });
        await dialog.waitFor({ state: 'visible' });
        // Native dialogs can visit browser chrome at the tab boundary, but not the background page.
        await tabTo(page.locator(`#close-${id}`));
        await page.keyboard.press('Shift+Tab');
        if (await page.evaluate(() => document.activeElement === document.body)) await page.keyboard.press('Shift+Tab');
        assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)), 'Modal focus escaped');
        await fits(dialog);
        return dialog;
      }
      async function close(id, method, expected) {
        if (method === 'Escape') await page.keyboard.press('Escape');
        else await activate(page.locator(`#close-${id}`));
        await page.locator(`#${id}-dialog`).waitFor({ state: 'hidden' });
        await focused(expected);
        await fits();
      }
      async function rebuild() {
        // Simulate an in-flight state response rebuilding cards while a modal is open.
        // This changes data/DOM only; opening, closing and focus use real keyboard input.
        assert.ok(await page.evaluate(async () => {
          const modal = document.querySelector('dialog[open]'), active = document.activeElement;
          await refresh();
          return !modal || document.activeElement === active;
        }), 'Refresh moved focus out of the dialog');
      }

      const newTask = page.locator('#new-task');
      for (const method of ['Escape', 'Close']) {
        await open(newTask, 'task');
        await rebuild();
        await close('task', method, newTask);
      }
      await open(newTask, 'task');
      const title = `Keyboard focus ${width}px ${Date.now()}`;
      await tabTo(page.locator('#title'));
      await page.keyboard.type(title);
      await tabTo(page.locator('#intent'));
      await page.keyboard.type('Correct the fixture spelling and inspect the scoped edit evidence.');
      await activate(page.getByRole('button', { name: 'Create task', exact: true }));
      await page.getByRole('status').filter({ hasText: 'Workflow task created.' }).waitFor();
      await focused(newTask);
      // The new task's record is shown as soon as it is created.
      const card = page.locator('#record').filter({ has: page.getByRole('heading', { name: title, exact: true, level: 1 }) });
      for (const action of ['Generate plan', 'Request review', 'Approve plan']) {
        await activate(card.getByRole('button', { name: action, exact: true }));
        await page.getByRole('status').filter({ hasText: `${action} completed.` }).waitFor();
      }
      const plan = card.getByRole('button', { name: 'View plan', exact: true });
      const run = card.getByRole('button', { name: 'Run scoped edits', exact: true });
      for (const [id, trigger] of [['plan', plan], ['run', run]]) {
        for (const replaced of [false, true]) {
          for (const method of ['Escape', 'Close']) {
            await open(trigger, id);
            const old = await trigger.elementHandle();
            if (replaced) {
              await rebuild();
              assert.equal(await old.evaluate(el => el.isConnected), false, 'Trigger was not replaced');
            }
            await close(id, method, trigger);
          }
        }
      }
      for (const method of ['Escape', 'Close']) {
        await open(run, 'run');
        // A concurrent run makes this action temporarily unavailable.
        await page.evaluate(() => { state.runner.active = true; render(); });
        await close('run', method, plan);
        await rebuild();
        await focused(plan);
        await open(plan, 'plan');
        // A filter/state refresh can remove the entire task from the visible board.
        await page.evaluate(() => { state.tasks = []; render(); });
        await close('plan', method, page.locator('#workflow-heading'));
        await rebuild();
      }

      await open(run, 'run');
      await tabTo(page.locator('#edits'));
      await page.keyboard.type('invalid JSON');
      await activate(page.getByRole('button', { name: 'Run edits & static checks', exact: true }));
      await page.waitForFunction(() => !document.querySelector('#run-form').hasAttribute('aria-busy'));
      assert.ok(await page.locator('#run-dialog').evaluate(el => el.open), 'Rejected submission must keep the modal open');
      // The explanation sits inside the dialog, in an alert region, and the field is marked invalid.
      assert.match(await page.locator('#run-dialog [role=alert]').innerText(), /Edits not run/);
      assert.equal(await page.locator('#edits').getAttribute('aria-invalid'), 'true');
      await tabTo(page.locator('#edits'));
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(JSON.stringify([{ path: 'hello.mjs', before: '"helo"', after: '"hello"' }]));
      await page.screenshot({ path: `qa/dialog-focus-run-${width}.png` });
      await activate(page.getByRole('button', { name: 'Run edits & static checks', exact: true }));
      await page.getByRole('status').filter({ hasText: 'Runner started.' }).waitFor();
      const returnPoint = await run.isEnabled() ? run : plan;
      await focused(returnPoint);
      // Also cover a delayed refresh after the native close event has already fired.
      await rebuild();
      await focused(returnPoint === run && await run.isEnabled() ? run : plan);
      // The evidence is part of the record; there is no evidence dialog any more.
      const record = page.locator('#record');
      await record.getByText('Scoped edits and static checks passed. Project tests were not run.', { exact: true }).waitFor({ timeout: 30000 });
      const patchRegion = page.getByRole('region', { name: 'Patch for hello.mjs' });
      await patchRegion.waitFor();
      assert.match(await record.innerText(), /syntax:hello\.mjs/);
      assert.match(await patchRegion.innerText(), /export const greeting = "hello";/);
      // A refresh that rebuilds the record keeps focus on a rebuilt copy button.
      const copy = page.getByRole('button', { name: 'Copy pinned commit', exact: true });
      await tabTo(copy);
      await rebuild();
      await focused(copy);
      // Keyboard reach: the patch is a focusable, scrollable region.
      await tabTo(patchRegion);
      await page.screenshot({ path: `qa/dialog-focus-return-${width}.png` });
      for (const method of ['Escape', 'Close']) {
        await open(newTask, 'task');
        await page.evaluate(() => { state.projects = []; render(); });
        await close('task', method, page.locator('#workflow-heading'));
        await rebuild();
      }
      report.viewports.push({ width, keyboardOnly: true, nativeModal: true, escapeAndClose: true,
        taskAndRunSubmission: true, replacedTriggers: true, unavailableTriggers: true,
        postCloseRefresh: true, evidenceInRecord: true, focusVisible: true, dialogNames: true,
        overflow: false, realLocalRun: 'passed' });
      await page.close();
    }
    assert.deepEqual(report.pageErrors, []);
    fs.writeFileSync('qa/dialog-focus-result.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const page = browser.contexts().at(-1)?.pages().at(-1);
    if (page) await page.screenshot({ path: 'qa/dialog-focus-failure.png' });
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
