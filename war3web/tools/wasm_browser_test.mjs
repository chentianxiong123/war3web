// M1: 无头浏览器加载 wasm 页面，验证 war3core 在浏览器端可用。
// 依赖构建产物 wasm/out/war3core.{js,wasm}（先跑 bash tools/build_wasm.sh）。
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = process.env.PORT || '8078';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css',
};

const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + pathname); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let failed = 0;
try {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/wasm/test_page.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.dataset.passed != null, { timeout: 20000 });
  const log = await page.evaluate(() => document.getElementById('log').textContent);
  const passed = await page.evaluate(() => document.body.dataset.passed === 'yes');
  console.log('浏览器端结果:');
  console.log(log.split('\n').map((l) => '  ' + l).join('\n'));
  if (!passed) failed++;
  await browser.close();
} catch (e) {
  failed++;
  console.error('浏览器测试失败:', e.message);
} finally {
  server.close();
}

console.log(failed ? `\n${failed} browser failure` : '\nbrowser ok');
process.exit(failed ? 1 : 0);