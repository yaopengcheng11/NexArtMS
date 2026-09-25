// 浏览器探针：混剪项目页（列表/创建/工作台渲染）。
// 用法：BASE_URL=http://127.0.0.1:8199 node scripts/browser-studio-probe.mjs
// 只读验证：不修改项目数据。报告写入 reports/studio-browser.json。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8199';

let playwright;
try {playwright = await import('playwright');}
catch {const modulePath = process.env.PLAYWRIGHT_MODULE;if (!modulePath) {console.error('需要 playwright：npx playwright install chromium');process.exit(1);}playwright = await import(modulePath);}
const executablePath = process.env.CHROME_PATH || undefined;

const browser = await playwright.chromium.launch({executablePath});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const consoleErrors = [];
page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
page.on('pageerror', error => consoleErrors.push(String(error)));

const result = {baseUrl, checks: [], consoleErrors};
const check = (name, pass, detail = '') => {result.checks.push({name, pass, detail});console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);};

try {
  await page.goto(baseUrl + '/', {waitUntil: 'networkidle'});
  await page.waitForTimeout(600);
  check('列表页创建表单可见', await page.locator('.studio-create input').isVisible());
  check('场景模式选择可见', await page.locator('.studio-mode-picker button').count() === 2);
  await page.screenshot({path: path.join(root, 'reports', 'studio-list.png')});

  const projectCards = page.locator('.studio-project-card');
  if (await projectCards.count() > 0) {
    await projectCards.first().click();
    await page.waitForTimeout(1200);
    check('工作台阶段条可见', await page.locator('.studio-steps').isVisible());
    check('任务面板可见', await page.locator('#studio-jobs').isVisible());
    check('角色归并面板可见', await page.locator('#studio-cast').isVisible());
    const mediaCardVisible = await page.locator('text=已导入媒体').first().isVisible().catch(() => false);
    const importCardVisible = await page.locator('text=导入媒体').first().isVisible().catch(() => false);
    check('媒体/导入区可见', mediaCardVisible || importCardVisible);
    await page.screenshot({path: path.join(root, 'reports', 'studio-project.png'), fullPage: true});
  } else {
    check('存在可打开的项目', false, '列表为空，可先通过 API 创建项目');
  }
} finally {
  await browser.close();
}
result.passed = result.checks.filter(item => item.pass).length;
result.failed = result.checks.filter(item => !item.pass).length;
fs.mkdirSync(path.join(root, 'reports'), {recursive: true});
fs.writeFileSync(path.join(root, 'reports', 'studio-browser.json'), JSON.stringify(result, null, 2));
console.log(`完成：${result.passed} 通过 / ${result.failed} 失败；报告 reports/studio-browser.json`);
process.exit(result.failed > 0 ? 1 : 0);
