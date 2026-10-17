// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Practice battle (auto-deploy → confirm) and keeps firing through the visible Hint key and
// Fire button, so shots, splashes, sparks, the sea and the sonar sweep animate. A finished battle is
// restarted from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__fleet?.app?.phase === 'menu', null, { timeout: 20000 });
  await page.click('button[data-act="settings"]');
  await page.waitForSelector('#gfx-section #gfx-preset');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('[data-act="done"]');
  await page.waitForSelector('.game-title');
}

async function launch(page) {
  await page.click('button[data-act="play"]');
  await page.waitForSelector('[data-act="launch"]');
  await page.click('[data-act="launch"]');
  await page.waitForSelector('[data-tact="auto"]', { timeout: 15000 });
  await page.click('[data-tact="auto"]');
  await page.waitForSelector('[data-tact="confirm"]:not([disabled])');
  await page.click('[data-tact="confirm"]');
}

export async function start(page) {
  await launch(page);
  await page.waitForFunction(() => window.__fleet.app.phase === 'battle', null, { timeout: 20000 });
  let stopped = false;
  page.once('close', () => { stopped = true; });
  (async () => {
    while (!stopped) {
      try {
        if (await page.locator('.result-headline').count()) {
          await page.click('.overlay [data-act="title"]');
          await page.waitForSelector('.game-title');
          await launch(page);
        } else {
          await page.keyboard.press('h');
          await page.waitForTimeout(120);
          const fire = page.locator('[data-tact="fire"]');
          if (await fire.isEnabled().catch(() => false)) await fire.click({ timeout: 1000 });
        }
      } catch { /* screen changing */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  await page.waitForTimeout(500);
}
