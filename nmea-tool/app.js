/*
 * app.js — 页面逻辑：合成数据播放、断连模拟、配对窗口调整、各视图渲染、轨迹图、导出。
 */
(function () {
  'use strict';
  const E = window.NMEAEngine;
  const G = window.NMEAGenerator;
  const store = E.createStore({ windowMs: 2000 });

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtRecv = (ms) => new Date(ms).toISOString().slice(11, 23);
  const fmtClock = (d) => d.toTimeString().slice(0, 8);

  /* ---------------- 事件日志 ---------------- */
  const events = [];
  function logEvent(text) {
    events.unshift({ t: new Date(), text });
    if (events.length > 300) events.pop();
    renderEvents();
  }

  /* ---------------- 合成数据播放器 ---------------- */
  const player = {
    lines: [], idx: 0, playing: false, paused: false,
    timer: null, t0: 0, off: 0, speed: 5,
    sent: [],        // 已成功发送的 {t, line}（用于"重发最近 5 秒"）
    dropped: [],     // 断连期间丢弃的 {t, line}
    finished: false,
  };

  function currentSpeed() {
    const v = $('selSpeed').value;
    return v === '0' ? 0 : parseFloat(v);
  }

  function loadScenario() {
    const key = $('selScenario').value;
    const date = $('inpDate').value || new Date().toISOString().slice(0, 10);
    const sc = G.buildScenario(key, date);
    player.lines = sc.lines;
    player.idx = 0;
    player.off = 0;
    player.sent = [];
    player.dropped = [];
    player.finished = false;
    $('playInfo').textContent = `已装载「${sc.name}」：${sc.lines.length} 句，待播放。`;
  }

  function emitLine(item) {
    if (!conn.connected) {
      player.dropped.push(item);
      renderConn();
      return;
    }
    E.ingestLine(store, item.line);
    player.sent.push(item);
  }

  function tick() {
    const elapsed = (performance.now() - player.t0) * player.speed + player.off;
    while (player.idx < player.lines.length && player.lines[player.idx].t <= elapsed) {
      emitLine(player.lines[player.idx++]);
    }
    if (player.idx >= player.lines.length) { finishPlay(); return; }
    $('playInfo').textContent = `播放中：${player.idx}/${player.lines.length} 句 · 流内时间 +${(elapsed / 1000).toFixed(1)}s`;
    renderAll();
  }

  function startPlay() {
    if (player.playing) return;
    if (player.finished || player.idx >= player.lines.length) loadScenario();
    if (!player.lines.length) loadScenario();
    player.speed = currentSpeed();
    if (player.speed === 0) { // 瞬时：同步播完剩余全部
      const name = $('selScenario').selectedOptions[0].textContent;
      while (player.idx < player.lines.length) emitLine(player.lines[player.idx++]);
      logEvent(`瞬时播放「${name}」完成`);
      finishPlay();
      return;
    }
    player.playing = true;
    player.paused = false;
    player.t0 = performance.now();
    if (player.off === 0 && player.idx === 0) {
      logEvent(`开始播放「${$('selScenario').selectedOptions[0].textContent}」（${player.speed}×）`);
    }
    player.timer = setInterval(tick, 40);
    $('btnPlay').disabled = true;
    $('btnPause').disabled = false;
  }

  function pausePlay() {
    if (!player.playing) return;
    clearInterval(player.timer);
    player.off += (performance.now() - player.t0) * player.speed;
    player.playing = false;
    player.paused = true;
    $('btnPlay').disabled = false;
    $('btnPause').disabled = true;
    $('playInfo').textContent = `已暂停：${player.idx}/${player.lines.length} 句。`;
  }

  function finishPlay() {
    clearInterval(player.timer);
    player.playing = false;
    player.finished = true;
    player.off = 0;
    E.flushPending(store, '数据流结束（播放完成）');
    logEvent(`播放结束：接收 ${store.stats.lines} 句，位置 ${store.positions.length} 个，待处理 ${store.pending.length} 条`);
    $('btnPlay').disabled = false;
    $('btnPause').disabled = true;
    $('playInfo').textContent = '播放完成。可"重放本段"验证幂等去重，或清空后重新播放。';
    renderAll();
  }

  function stopPlay() {
    if (!player.playing && !player.paused && player.idx === 0) return;
    clearInterval(player.timer);
    player.playing = false;
    player.paused = false;
    E.flushPending(store, '数据流结束（手动停止）');
    logEvent(`手动停止：已播 ${player.idx}/${player.lines.length} 句，缓冲池已结算`);
    player.idx = 0;
    player.off = 0;
    player.finished = true;
    $('btnPlay').disabled = false;
    $('btnPause').disabled = true;
    $('playInfo').textContent = '已停止。再次播放将从头生成相同句子（会被去重），如需重来请先"清空全部数据"。';
    renderAll();
  }

  function replaySegment() {
    if (!player.lines.length) return;
    const before = { dup: store.stats.dup, pos: store.positions.length, pend: store.pending.length };
    player.lines.forEach((l) => E.ingestLine(store, l.line));
    logEvent(
      `重放本段 ${player.lines.length} 句：判重忽略 ${store.stats.dup - before.dup} 句，` +
      `新增位置 ${store.positions.length - before.pos} 个，新增待处理 ${store.pending.length - before.pend} 条`
    );
    renderAll();
  }

  /* ---------------- 连接模拟 ---------------- */
  const conn = { connected: true, dropTotal: 0, autoTimer: null };

  function disconnect() {
    if (!conn.connected) return;
    conn.connected = false;
    player.dropped = [];
    logEvent('连接断开：数据流中断');
    const auto = parseInt($('inpAutoRe').value, 10);
    if (auto > 0) {
      conn.autoTimer = setTimeout(() => { reconnect(); }, auto * 1000);
      logEvent(`将在 ${auto}s 后自动重连`);
    }
    renderConn();
    renderAll();
  }

  function reconnect() {
    if (conn.connected) return;
    clearTimeout(conn.autoTimer);
    conn.connected = true;
    const dropped = player.dropped.splice(0);
    let resent = 0;
    if ($('chkResend').checked && dropped.length) {
      dropped.forEach((l) => { E.ingestLine(store, l.line); player.sent.push(l); });
      resent = dropped.length;
    } else {
      conn.dropTotal += dropped.length;
    }
    let replayed = 0;
    if ($('chkReplayRecent').checked && player.sent.length) {
      const lastT = player.sent[player.sent.length - 1].t;
      const recent = player.sent.filter((s) => s.t >= lastT - 5000);
      recent.forEach((l) => E.ingestLine(store, l.line)); // 完全相同 → 判重忽略
      replayed = recent.length;
    }
    logEvent(`连接恢复：补发缓存 ${resent} 句，重发已发送 ${replayed} 句（重复自动忽略），累计丢弃 ${conn.dropTotal} 句`);
    renderConn();
    renderAll();
  }

  function renderConn() {
    $('connStatus').className = 'conn ' + (conn.connected ? 'on' : 'off');
    $('connStatus').innerHTML = conn.connected
      ? '<span class="dot"></span>已连接'
      : `<span class="dot"></span>已断开（断连期间已丢弃 ${player.dropped.length} 句）`;
    $('dropInfo').textContent = conn.dropTotal ? `累计丢弃（未补发）：${conn.dropTotal} 句` : '';
  }

  /* ---------------- 渲染 ---------------- */
  const STATE_BADGE = {
    pool: ['pool', '缓冲中'],
    paired: ['paired', '已配对'],
    pending: ['pending', '待处理'],
    nofix: ['nofix', '无定位'],
    dup: ['muted', '重复'],
    checksum_err: ['err', '校验和错误'],
    parse_err: ['err', '解析失败'],
    ignored: ['muted', '已忽略'],
  };

  function badge(state) {
    const [cls, label] = STATE_BADGE[state] || ['muted', state];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function renderStats() {
    const s = store.stats;
    $('stats').innerHTML = [
      `<span class="chip">接收<b>${s.lines}</b></span>`,
      `<span class="chip">有效<b>${s.valid}</b></span>`,
      `<span class="chip accent">位置<b>${store.positions.length}</b></span>`,
      `<span class="chip warn">待处理<b>${store.pending.length}</b></span>`,
      `<span class="chip">无定位<b>${s.nofix}</b></span>`,
      `<span class="chip">重复<b>${s.dup}</b></span>`,
      `<span class="chip bad">校验错<b>${s.checksumErr}</b></span>`,
      `<span class="chip bad">解析错<b>${s.parseErr}</b></span>`,
      `<span class="chip">已忽略<b>${s.ignored}</b></span>`,
    ].join('');
    $('posBadge').textContent = store.positions.length || '';
    $('pendingBadge').textContent = store.pending.length || '';
    $('pendingBadge').className = 'tabbadge' + (store.pending.length ? ' warn' : '');
  }

  const LOG_CAP = 300;

  function sentenceNote(s) {
    if (s.state === 'dup') return `与 #${s.dupOfSeq} 完全相同的句子，已忽略`;
    if (s.state === 'checksum_err') return '校验和不匹配，拒绝解析';
    if (s.state === 'parse_err') return esc(s.error || '');
    if (s.state === 'ignored') return '非 RMC/GGA 句型，按规则忽略';
    if (s.state === 'nofix') {
      return s.type === 'RMC' ? '状态 V（定位无效），不参与配对' : `质量指示 ${s.quality}（无定位），不参与配对`;
    }
    if (s.state === 'paired') return `配对成功 → ${s.pairId}`;
    if (s.state === 'pool') return '在配对缓冲池中等待';
    if (s.state === 'pending') {
      const rec = store.pending.find((p) => p.sentence === s);
      return rec ? esc(rec.reason + '：' + rec.detail) : '待处理';
    }
    return '';
  }

  function renderLog() {
    const filter = $('logFilter').value;
    const list = store.sentences;
    const rows = [];
    let shown = 0;
    for (let i = list.length - 1; i >= 0 && shown < LOG_CAP; i--) {
      const s = list[i];
      if (filter && s.state !== filter) continue;
      shown++;
      rows.push(
        `<tr><td class="num">${s.seq}</td><td class="time">${fmtRecv(s.receivedAt)}</td>` +
        `<td>${s.type ? esc(s.type) : '—'}</td><td>${badge(s.state)}</td>` +
        `<td class="raw">${esc(s.raw)}</td><td class="hint">${sentenceNote(s)}</td></tr>`
      );
    }
    $('tblLog').querySelector('tbody').innerHTML = rows.join('');
    $('logCount').textContent = `共 ${list.length} 条${list.length > LOG_CAP ? `，仅显示最近 ${LOG_CAP} 条` : ''}（倒序）`;
  }

  function renderPositions() {
    const pos = E.sortedPositions(store);
    const CAP = 1000;
    const rows = pos.slice(0, CAP).map((p) =>
      `<tr><td class="time">${esc(p.iso.slice(0, 19).replace('T', ' '))}</td><td>${p.date}</td>` +
      `<td class="num">${p.lat.toFixed(7)}</td><td class="num">${p.lon.toFixed(7)}</td>` +
      `<td class="num">${p.altM == null ? '—' : p.altM.toFixed(1)}</td>` +
      `<td class="num">${p.speedKnots == null ? '—' : p.speedKnots.toFixed(2)}</td>` +
      `<td class="num">${p.courseDeg == null ? '—' : p.courseDeg.toFixed(1)}</td>` +
      `<td class="num">${p.numSats == null ? '—' : p.numSats}</td>` +
      `<td class="num">${p.hdop == null ? '—' : p.hdop.toFixed(1)}</td>` +
      `<td>${p.posSource}</td><td class="num">${(Math.abs(p.deltaMs) / 1000).toFixed(2)}</td>` +
      `<td class="rationale">${esc(p.rationale)}</td></tr>`
    );
    $('tblPos').querySelector('tbody').innerHTML = rows.join('');
    $('posCount').textContent = `共 ${pos.length} 个标准化位置点（按 UTC 时间排序）` +
      (pos.length > CAP ? `，仅显示前 ${CAP} 条` : '');
  }

  function renderPending() {
    const rows = store.pending.map((rec) => {
      const s = rec.sentence;
      return `<tr><td class="num">${s.seq}</td><td>${esc(s.type)}</td><td class="time">${fmtRecv(s.receivedAt)}</td>` +
        `<td><span class="badge pending">${esc(rec.reason)}</span></td>` +
        `<td class="hint">${esc(rec.detail)}</td><td class="raw">${esc(s.raw)}</td></tr>`;
    });
    $('tblPending').querySelector('tbody').innerHTML = rows.join('');
  }

  function renderEvents() {
    $('eventList').innerHTML = events
      .map((e) => `<li><span class="t">${fmtClock(e.t)}</span>${esc(e.text)}</li>`)
      .join('');
  }

  function renderAll() {
    renderStats();
    renderLog();
    renderPositions();
    renderPending();
    if ($('tab-track').classList.contains('on')) drawTrack();
  }

  /* ---------------- 轨迹图（Canvas，等距圆柱投影，按日分段着色） ---------------- */
  // 分类色板（dataviz 参考调色板，固定顺序）；超过 8 天折叠为"其他"灰
  const DAY_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  const OTHER_COLOR = '#898781';
  const INK_3 = '#898781';
  const GRID = '#e1e0d9';
  const SURFACE = '#fcfcfb';
  let trackGeom = null;

  function dayColor(i) { return i < DAY_COLORS.length ? DAY_COLORS[i] : OTHER_COLOR; }

  function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) {
      if (raw <= m * mag) return m * mag;
    }
    return 10 * mag;
  }

  function drawTrack(highlight) {
    const canvas = $('trackCanvas');
    const wrap = $('trackWrap');
    const W = Math.max(320, wrap.clientWidth);
    const H = 440;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const pos = E.sortedPositions(store);
    trackGeom = null;
    if (!pos.length) {
      $('trackLegend').innerHTML = '';
      ctx.fillStyle = INK_3;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无位置数据 —— 播放合成数据后在此绘制轨迹', W / 2, H / 2);
      return;
    }

    // 经纬度范围（经度按 cos 平均纬度缩放，保持形状比例）
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of pos) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    const meanLat = (minLat + maxLat) / 2;
    const kx = Math.cos((meanLat * Math.PI) / 180);
    let spanLat = Math.max(maxLat - minLat, 0.0002);
    let spanLon = Math.max(maxLon - minLon, 0.0002);
    const padLat = spanLat * 0.12, padLon = spanLon * 0.12;
    minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;
    spanLat = maxLat - minLat; spanLon = maxLon - minLon;

    const M = { l: 64, r: 20, t: 18, b: 34 };
    const plotW = W - M.l - M.r;
    const plotH = H - M.t - M.b;
    const scale = Math.min(plotW / (spanLon * kx), plotH / spanLat);
    const ox = M.l + (plotW - spanLon * kx * scale) / 2;
    const oy = M.t + (plotH - spanLat * scale) / 2;
    const proj = (lat, lon) => [ox + (lon - minLon) * kx * scale, oy + (maxLat - lat) * scale];

    // 网格与刻度（细分网格线 + 轴标签，墨色不抢数据）
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = INK_3;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    const latStep = niceStep(spanLat, 5);
    ctx.textAlign = 'right';
    for (let v = Math.ceil(minLat / latStep) * latStep; v <= maxLat; v += latStep) {
      const [, y] = proj(v, minLon);
      ctx.beginPath(); ctx.moveTo(M.l - 4, y); ctx.lineTo(W - M.r, y); ctx.stroke();
      ctx.fillText(v.toFixed(4), M.l - 8, y + 3.5);
    }
    const lonStep = niceStep(spanLon, 6);
    ctx.textAlign = 'center';
    for (let v = Math.ceil(minLon / lonStep) * lonStep; v <= maxLon; v += lonStep) {
      const [x] = proj(minLat, v);
      ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, H - M.b + 4); ctx.stroke();
      ctx.fillText(v.toFixed(4), x, H - M.b + 16);
    }
    ctx.textAlign = 'left';
    ctx.fillText('纬度°', 6, M.t + 4);
    ctx.textAlign = 'right';
    ctx.fillText('经度°', W - M.r, H - 6);

    // 按日期分段（每天一段独立折线，不跨日连线）
    const days = [];
    for (const p of pos) {
      const last = days[days.length - 1];
      if (last && last.date === p.date) last.points.push(p);
      else days.push({ date: p.date, points: [p] });
    }
    days.forEach((d, i) => { d.color = dayColor(i); });

    for (const d of days) {
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      d.points.forEach((p, j) => {
        const [x, y] = proj(p.lat, p.lon);
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // 中间点小圆点
      ctx.fillStyle = d.color;
      for (const p of d.points) {
        const [x, y] = proj(p.lat, p.lon);
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    // 全轨迹起点 / 终点标记（带 2px 表面色圆环）
    const mark = (p, color) => {
      const [x, y] = proj(p.lat, p.lon);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = SURFACE; ctx.stroke();
    };
    mark(pos[0], days[0].color);
    mark(pos[pos.length - 1], days[days.length - 1].color);

    // 图例：≥2 个日期才出现图例行；单日用文字说明
    if (days.length > 1) {
      $('trackLegend').innerHTML = days.map((d) =>
        `<span class="item"><span class="swatch" style="background:${d.color}"></span>${d.date}（${d.points.length} 点）</span>`
      ).join('') + (days.length > DAY_COLORS.length ? '<span class="caption">超出 8 天的部分统一为灰色</span>' : '');
    } else {
      $('trackLegend').innerHTML = `<span class="caption">轨迹日期：${days[0].date}（${days[0].points.length} 点）· ● 起点 / 终点标记</span>`;
    }

    trackGeom = { proj, pos, W, H };

    // 悬停高亮（十字线 + 强调点）
    if (highlight) {
      const [x, y] = proj(highlight.lat, highlight.lon);
      ctx.strokeStyle = INK_3;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(W - M.r, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, H - M.b); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = highlight.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = SURFACE; ctx.stroke();
    }
  }

  function onTrackHover(ev) {
    if (!trackGeom) return;
    const rect = $('trackCanvas').getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    let best = null, bestD = 14; // 命中半径 14px
    for (const p of trackGeom.pos) {
      const [x, y] = trackGeom.proj(p.lat, p.lon);
      const d = Math.hypot(x - mx, y - my);
      if (d < bestD) { bestD = d; best = p; }
    }
    const tip = $('trackTip');
    if (!best) {
      tip.hidden = true;
      drawTrack();
      return;
    }
    const dayIdx = [...new Set(trackGeom.pos.map((p) => p.date))].indexOf(best.date);
    best.color = dayColor(dayIdx);
    drawTrack(best);
    tip.hidden = false;
    tip.innerHTML =
      `<div class="t">${esc(best.iso.slice(0, 19).replace('T', ' '))} UTC</div>` +
      `${best.lat.toFixed(6)}, ${best.lon.toFixed(6)}` +
      (best.altM == null ? '' : ` · 海拔 ${best.altM.toFixed(1)} m`) +
      (best.speedKnots == null ? '' : ` · ${best.speedKnots.toFixed(1)} kn`) +
      `<br>位置来源 ${best.posSource} · |Δt| ${(Math.abs(best.deltaMs) / 1000).toFixed(2)}s · ${esc(best.id)}`;
    const [x, y] = trackGeom.proj(best.lat, best.lon);
    tip.style.left = Math.min(x + 14, trackGeom.W - 240) + 'px';
    tip.style.top = Math.max(y - 70, 6) + 'px';
  }

  /* ---------------- 导出 ---------------- */
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');
  }

  function exportCSV() {
    const pos = E.sortedPositions(store);
    if (!pos.length) { logEvent('导出取消：暂无位置数据'); return; }
    download(`track_${stamp()}.csv`, '\ufeff' + E.positionsToCSV(pos), 'text/csv;charset=utf-8');
    logEvent(`导出轨迹 CSV：${pos.length} 个位置点`);
  }

  function exportGeoJSON() {
    const pos = E.sortedPositions(store);
    if (!pos.length) { logEvent('导出取消：暂无位置数据'); return; }
    download(`track_${stamp()}.geojson`, E.positionsToGeoJSON(pos), 'application/geo+json;charset=utf-8');
    logEvent(`导出轨迹 GeoJSON：${pos.length} 个位置点`);
  }

  function exportLog() {
    if (!store.sentences.length) { logEvent('导出取消：暂无接入记录'); return; }
    download(`ingest_${stamp()}.csv`, '\ufeff' + E.sentencesToCSV(store.sentences), 'text/csv;charset=utf-8');
    logEvent(`导出接入明细 CSV：${store.sentences.length} 行`);
  }

  /* ---------------- 初始化与事件绑定 ---------------- */
  function init() {
    // 场景下拉
    $('selScenario').innerHTML = G.listScenarios()
      .map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join('');
    const showDesc = () => {
      const s = G.listScenarios().find((x) => x.key === $('selScenario').value);
      $('scenarioDesc').textContent = s ? s.description : '';
    };
    showDesc();
    $('inpDate').value = new Date().toISOString().slice(0, 10);

    // 日志过滤下拉
    const filter = $('logFilter');
    Object.entries(E.STATE_LABELS).forEach(([k, v]) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = v;
      filter.appendChild(o);
    });
    filter.addEventListener('change', renderLog);

    // 页签
    $('tabs').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-tab]');
      if (!btn) return;
      document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b === btn));
      document.querySelectorAll('.tabpage').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + btn.dataset.tab));
      if (btn.dataset.tab === 'track') drawTrack();
    });

    // 播放控制（切换场景/日期时先停止当前播放，避免新旧流混杂）
    $('btnPlay').addEventListener('click', startPlay);
    $('btnPause').addEventListener('click', pausePlay);
    $('btnStop').addEventListener('click', stopPlay);
    $('btnReplay').addEventListener('click', replaySegment);
    const stopIfPlaying = () => { if (player.playing || player.paused) stopPlay(); };
    $('selScenario').addEventListener('change', () => { stopIfPlaying(); showDesc(); loadScenario(); });
    $('inpDate').addEventListener('change', () => { stopIfPlaying(); loadScenario(); });
    $('btnPause').disabled = true;

    // 手动接收：逐行 ingest，不自动结算（缓冲池等待后续数据或手动结算）
    $('btnManual').addEventListener('click', () => {
      const lines = $('inpManual').value.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return;
      const before = { lines: store.stats.lines, dup: store.stats.dup };
      lines.forEach((l) => E.ingestLine(store, l));
      logEvent(
        `手动接收 ${lines.length} 行：判重忽略 ${store.stats.dup - before.dup} 句，` +
        `当前位置 ${store.positions.length} 个，待处理 ${store.pending.length} 条`
      );
      renderAll();
    });

    // 连接模拟
    $('btnDisconnect').addEventListener('click', disconnect);
    $('btnReconnect').addEventListener('click', reconnect);

    // 配对设置
    $('btnApplyWindow').addEventListener('click', () => {
      const sec = parseFloat($('inpWindow').value);
      if (!(sec >= 0.1 && sec <= 120)) { logEvent('窗口值无效（0.1–120 秒）'); return; }
      store.windowMs = Math.round(sec * 1000);
      E.reprocess(store);
      logEvent(`配对窗口调整为 ${sec}s 并重新配对：位置 ${store.positions.length} 个，待处理 ${store.pending.length} 条`);
      renderAll();
    });
    $('btnFlush').addEventListener('click', () => {
      const n = store.poolRMC.size + store.poolGGA.size;
      E.flushPending(store, '手动结算');
      logEvent(`手动结算：${n} 句移入待处理区`);
      renderAll();
    });
    $('btnClear').addEventListener('click', () => {
      E.clearStore(store);
      conn.dropTotal = 0;
      loadScenario();
      logEvent('已清空全部数据');
      renderConn();
      renderAll();
    });

    // 导出
    $('btnExpCsv').addEventListener('click', exportCSV);
    $('btnExpGeo').addEventListener('click', exportGeoJSON);
    $('btnExpLog').addEventListener('click', exportLog);

    // 轨迹图交互
    $('trackCanvas').addEventListener('mousemove', onTrackHover);
    $('trackCanvas').addEventListener('mouseleave', () => { $('trackTip').hidden = true; drawTrack(); });
    new ResizeObserver(() => { if ($('tab-track').classList.contains('on')) drawTrack(); }).observe($('trackWrap'));

    loadScenario();
    renderConn();
    renderAll();
    logEvent('工具就绪：选择场景后点击"播放"');
  }

  init();
})();
