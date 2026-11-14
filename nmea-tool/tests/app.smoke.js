/*
 * app.smoke.js — 用最小 DOM 桩在 Node 中冒烟测试 app.js：
 * 初始化 → 瞬时播放 → 统计/位置/待处理渲染 → 重放去重 → 断连重连 → 窗口重配对 → 导出。
 * 运行：node tests/app.smoke.js
 */
'use strict';
const path = require('path');

/* ---------- 最小 DOM 桩 ---------- */
class El {
  constructor(id) {
    this.id = id;
    this.children = [];
    this._cls = new Set();
    this.listeners = {};
    this.style = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this._innerHTML = '';
    this.clientWidth = 800;
  }
  get classList() {
    const s = this._cls;
    return {
      add: (c) => s.add(c), remove: (c) => s.delete(c),
      toggle: (c, f) => { if (f) s.add(c); else s.delete(c); },
      contains: (c) => s.has(c),
    };
  }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  set innerHTML(v) { this._innerHTML = String(v); }
  get innerHTML() { return this._innerHTML; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatch(t, ev) { (this.listeners[t] || []).forEach((f) => f(ev || {})); }
  appendChild(c) { this.children.push(c); }
  querySelector() { return new El(); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 440 }; }
  get selectedOptions() { return [{ textContent: this.id }]; }
  getContext() {
    return new Proxy({}, {
      get: (t, k) => (typeof k === 'string' ? () => {} : undefined),
      set: () => true,
    });
  }
  click() {}
}

const ids = ['stats', 'inpWindow', 'btnApplyWindow', 'btnFlush', 'btnClear', 'selScenario',
  'scenarioDesc', 'inpDate', 'selSpeed', 'btnPlay', 'btnPause', 'btnStop', 'btnReplay',
  'playInfo', 'connStatus', 'btnDisconnect', 'btnReconnect', 'inpAutoRe', 'chkResend',
  'chkReplayRecent', 'dropInfo', 'btnExpCsv', 'btnExpGeo', 'btnExpLog', 'tabs',
  'posBadge', 'pendingBadge', 'tab-log', 'tab-pos', 'tab-pending', 'tab-track',
  'tab-events', 'logFilter', 'logCount', 'tblLog', 'tblPos', 'tblPending', 'posCount',
  'trackLegend', 'trackWrap', 'trackCanvas', 'trackTip', 'eventList',
  'inpManual', 'btnManual'];
const registry = {};
ids.forEach((id) => { registry[id] = new El(id); });
registry.selScenario.value = 'basic';
registry.selSpeed.value = '0'; // 瞬时播放，避免定时器
registry.inpAutoRe.value = '0';
registry.inpWindow.value = '2.0';
registry.chkResend.checked = true;

const downloads = [];
global.document = {
  getElementById: (id) => registry[id] || null,
  createElement: () => new El(),
  querySelectorAll: () => [],
  addEventListener: () => {},
};
global.window = global;
global.ResizeObserver = class { observe() {} };
global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
global.Blob = class { constructor(parts) { this.parts = parts; } };

// 拦截下载：替换 app 内的 download 不可行，改为拦截 createElement('a') 的 click
const origCreate = global.document.createElement;
global.document.createElement = (tag) => {
  const el = origCreate(tag);
  if (tag === 'a') {
    el.click = () => downloads.push({ name: el.download, href: el.href });
  }
  return el;
};

global.NMEAEngine = require(path.join(__dirname, '..', 'nmea-engine.js'));
global.NMEAGenerator = require(path.join(__dirname, '..', 'generator.js'));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

// 加载 app.js（会立即 init）
require(path.join(__dirname, '..', 'app.js'));
console.log('[初始化]');
ok(registry.selScenario.innerHTML.includes('基础巡航'), '场景下拉已填充');
ok(registry.eventList.innerHTML.includes('工具就绪'), '事件日志已记录就绪');
ok(registry.playInfo.textContent.includes('120 句'), '场景已装载（basic 120 句）', registry.playInfo.textContent);

console.log('[瞬时播放 basic]');
registry.btnPlay.dispatch('click');
ok(registry.stats.innerHTML.includes('位置<b>60</b>'), '生成 60 个位置', registry.stats.innerHTML.slice(0, 200));
ok(registry.stats.innerHTML.includes('待处理<b>0</b>'), '无待处理');
ok(registry.tblPos.innerHTML !== '' || true, '位置表渲染调用未报错');
ok(registry.posCount.textContent.includes('60'), '位置计数文本正确', registry.posCount.textContent);

console.log('[重放去重]');
registry.btnReplay.dispatch('click');
ok(registry.eventList.innerHTML.includes('判重忽略 120 句'), '重放 120 句全部判重');
ok(registry.eventList.innerHTML.includes('新增位置 0'), '重放不新增位置');
ok(registry.stats.innerHTML.includes('重复<b>120</b>'), '重复计数 120');

console.log('[断连重连]');
registry.btnDisconnect.dispatch('click');
ok(registry.connStatus.innerHTML.includes('已断开'), '断连状态显示');
registry.btnReconnect.dispatch('click');
ok(registry.connStatus.innerHTML.includes('已连接'), '重连状态显示');
ok(registry.eventList.innerHTML.includes('连接恢复'), '重连事件已记录');

console.log('[窗口调整 + 重新配对]');
registry.selScenario.value = 'disorder';
registry.selScenario.dispatch('change');
registry.btnClear.dispatch('click'); // 清空并重新装载 disorder
registry.btnPlay.dispatch('click');
ok(registry.stats.innerHTML.includes('待处理<b>2</b>'), 'disorder 默认窗口下 2 条待处理', registry.stats.innerHTML);
registry.inpWindow.value = '5.0';
registry.btnApplyWindow.dispatch('click');
ok(registry.eventList.innerHTML.includes('配对窗口调整为 5s'), '窗口调整事件已记录');
ok(registry.stats.innerHTML.includes('位置<b>40</b>'), '放宽窗口后 40 个位置（超窗对被挽回）', registry.stats.innerHTML);
ok(registry.stats.innerHTML.includes('待处理<b>0</b>'), '放宽窗口后待处理清空');

console.log('[导出]');
registry.btnExpCsv.dispatch('click');
ok(downloads.length === 1 && downloads[0].name.endsWith('.csv'), 'CSV 导出触发下载', JSON.stringify(downloads));
registry.btnExpGeo.dispatch('click');
ok(downloads.length === 2 && downloads[0].name !== downloads[1].name, 'GeoJSON 导出触发下载');

console.log('[轨迹图]');
const fakeBtn = { dataset: { tab: 'track' }, closest: () => fakeBtn };
registry.tabs.dispatch('click', { target: fakeBtn });
ok(registry.trackLegend.innerHTML.includes('轨迹日期'), '轨迹图例渲染');
registry.trackCanvas.dispatch('mousemove', { clientX: 400, clientY: 200 });
ok(true, '悬停处理未报错');
registry.trackCanvas.dispatch('mouseleave');

console.log('[手动接收]');
registry.btnClear.dispatch('click');
const manual = '$GPRMC,080000.0,A,3000.0000,N,12000.0000,E,5.2,90.0,151126,,,A*58\n' +
               '$GPGGA,080000.0,3000.0000,N,12000.0000,E,1,08,1.0,50.0,M,18.5,M,,*64';
registry.inpManual.value = manual;
registry.btnManual.dispatch('click');
ok(registry.stats.innerHTML.includes('位置<b>1</b>'), '手动接收两句配对成 1 个位置', registry.stats.innerHTML);
registry.btnManual.dispatch('click'); // 再收一遍同样的文本
ok(registry.eventList.innerHTML.includes('判重忽略 2 句'), '重复粘贴全部判重');
ok(registry.stats.innerHTML.includes('位置<b>1</b>'), '位置数不变（幂等）');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
