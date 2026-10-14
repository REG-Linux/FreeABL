// SPDX-License-Identifier: GPL-3.0-or-later
// Drives web/index.html?sim=1 in headless Chrome: install (check, backup, prove,
// flash, reboot) and back to stock over EDL, on the simulated device.
//   npm i --no-save puppeteer-core@25.9.0 && node web/test/ui-smoke.mjs
// CHROME=/path/to/chrome overrides the browser.
import http from 'node:http';
import { readFileSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

// SITE_ROOT: serve another tree, e.g. the Pages site built by pages.yml
const ROOT = process.env.SITE_ROOT ? join(process.env.SITE_ROOT, '/') : fileURLToPath(new URL('../..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/web/index.html?sim=1`;
const dl = mkdtempSync(join(tmpdir(), 'freeabl-dl-'));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
                                         args: ['--no-sandbox'] });
let failed = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' ' + extra}`); failed += !cond; };

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('log').textContent.includes('Simulation ready'));
  const log = () => page.$eval('#log', (e) => e.textContent);
  const until = (s) => page.waitForFunction((t) => document.getElementById('log').textContent.includes(t), { timeout: 5000 }, s)
    .catch(async (e) => { console.log(await log()); throw e; });
  const typePhrase = async (phrase) => {
    await page.waitForSelector('#confirm[open]');
    await page.type('#confirm-input', phrase);
    await page.click('#confirm-ok');
  };

  await page.select('#device', 'pockets');
  ok('flash locked before anything', await page.$eval('#btn-flash', (b) => b.disabled));
  ok('EDL restart locked before the fastboot check', await page.$eval('#btn-adb-edl', (b) => b.disabled));
  ok('file fields hidden by default', await page.$eval('#image-row', (e) => e.hidden) && await page.$eval('#loader-row', (e) => e.hidden));
  ok('says what is fetched', (await page.$eval('#auto-note', (e) => e.textContent)).includes('FreeABL v0.1.1 and the EDL loader'));
  await page.click('#untested');
  ok('expert mode shows them', !(await page.$eval('#image-row', (e) => e.hidden)) && !(await page.$eval('#loader-row', (e) => e.hidden)));
  await page.click('#untested');
  await page.click('#btn-adb');
  await until('Read only: nothing was changed');
  ok('Android read over USB debugging', (await log()).includes('FreeABL was run on this exact Android build'));
  await page.click('#btn-adb-fastboot');
  await until('Restarting in fastboot mode');
  await page.click('#btn-check');
  await until('active slot a');
  await page.click('#btn-fb-android');
  await until('Android is starting');
  await page.click('#btn-adb-edl');
  await until('Restarting in EDL');
  ok('reboots asked: fastboot, Android, EDL', await page.evaluate(() => window.freeablSim.reboots.join() === 'bootloader,android,edl'),
     await page.evaluate(() => String(window.freeablSim.reboots)));
  ok('check passes', (await log()).includes('OK: device SIM12345'));
  await page.click('#btn-backup');
  await until('Backup verified');
  ok('flash still locked before the backup is proven', await page.$eval('#btn-flash', (b) => b.disabled));
  const saved = async (re) => {
    for (let i = 0; i < 50 && !readdirSync(dl).some((f) => re.test(f)); i++) await new Promise((r) => setTimeout(r, 100));
    return readdirSync(dl).find((f) => re.test(f));
  };
  const tar = await saved(/^freeabl-backup-.*\.tar$/);
  ok('backup downloaded, named after the Android build', /^freeabl-backup-SIM12345-android13-2023-06-05-[0-9a-f]{8}\.tar$/.test(tar), String(readdirSync(dl)));
  ok('Android build shown', (await log()).includes('slot a: Android 13, security patch 2023-06-05'));
  await page.click('#btn-dump');
  await until('Firmware saved');
  const fw = await saved(/^freeabl-firmware-.*\.tar$/);
  ok('firmware saved', /^freeabl-firmware-SIM12345-android13-2023-06-05-[0-9a-f]{8}\.tar$/.test(fw), String(readdirSync(dl)));
  ok('firmware: userdata left out', (await log()).includes('Left out: userdata'));
  const proof = await page.$('#backup-proof');
  await proof.uploadFile(join(dl, tar));
  await until('flashing unlocked');
  ok('flash unlocked after proof', !(await page.$eval('#btn-flash', (b) => b.disabled)));
  await page.click('#btn-flash');
  await typePhrase('FLASH-ABL_A');
  await until('WRITE VERIFIED');
  ok('flashed and verified', (await log()).includes('WRITE VERIFIED: abl_a holds FreeABL'));
  ok('only abl_a written', await page.evaluate(() => window.freeablSim.writes.every((p) => p === 'abl_a')));
  await page.click('#btn-reset');
  await until('Rebooting');

  await page.click('[data-tab="restore"]');
  await (await page.$('#restore-backup')).uploadFile(join(dl, fw));
  await page.click('#btn-restore-edl');
  await typePhrase('RESTORE-ABL_A');
  await until('RESTORE VERIFIED');
  ok('restored over EDL from the firmware file', (await log()).includes('RESTORE VERIFIED'));
  ok('same Android build checked', (await log()).includes('backup and device on the same Android build'));
  ok('stock back on abl_a', await page.evaluate(() => window.freeablSim.parts.abl_a[0x104] === 7 && window.freeablSim.parts.abl_a[0x300] !== 0));

  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('log').textContent.includes('Simulation ready'));
  await page.select('#device', 'other');
  await page.click('#btn-check');
  await until('STOP');
  ok('other device needs tester mode', (await log()).includes('Tester mode'));
  await page.select('#soc', 'sm8650');
  await page.click('#untested');
  await page.click('#btn-check');
  await until('active slot a');
  await page.click('#btn-backup');
  await until('Backup verified');
  ok('tester report shown', await page.$eval('#report', (e) => !e.hidden && e.textContent.includes('soc sm8650')));
  await page.goto(url.replace('?sim=1', ''));
  await page.waitForFunction(() => /Ready|ERROR/.test(document.getElementById('log').textContent));
  ok('real mode loads the USB bundles', (await log()).includes('Ready.'), await log());
  if (process.env.SHOT) {
    await page.setViewport({ width: 900, height: 1500 });
    await page.screenshot({ path: process.env.SHOT, fullPage: true });
  }
  ok('no page errors', errors.length === 0, errors.join('; '));
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
