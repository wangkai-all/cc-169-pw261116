/*
 * nmea-engine.js
 * NMEA-0183 文本流接收引擎：只处理 RMC 与 GGA 两类句子。
 * 职责：校验和检查 → 字段解析 → 经纬度统一换算 → 按时间配对 RMC/GGA →
 *       跨午夜日期推断、乱序缓冲、无定位处理、幂等去重、待处理区。
 * 纯逻辑、无 DOM 依赖，浏览器（window.NMEAEngine）与 Node（module.exports）双端可用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NMEAEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;

  /* ---------------- 基础工具 ---------------- */

  // FNV-1a 哈希：句子去重键 / 记录 ID
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // 校验和：'$' 与 '*' 之间全部字符逐字节异或，大写两位十六进制
  function checksumOf(body) {
    let cs = 0;
    for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
    return cs.toString(16).toUpperCase().padStart(2, '0');
  }

  // 校验和检查：任何解析之前的第一步；格式不完整（缺 $/*/两位hex）一律视为校验失败
  function verifyChecksum(line) {
    const m = /^\$([^*]+)\*([0-9A-Fa-f]{2})$/.exec(line);
    if (!m) return false;
    return checksumOf(m[1]) === m[2].toUpperCase();
  }

  // hhmmss.ss → 当日毫秒（UTC）；非法返回 null
  function parseTimeOfDay(s) {
    if (!s || s.length < 6) return null;
    const hh = +s.slice(0, 2);
    const mm = +s.slice(2, 4);
    const ss = +s.slice(4);
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
    if (hh > 23 || mm > 59 || ss >= 60) return null;
    return Math.round(((hh * 60 + mm) * 60 + ss) * 1000);
  }

  // ddmmyy → 'YYYY-MM-DD'；yy<80 视为 20yy，否则 19yy
  function parseDate(s) {
    if (!s || s.length !== 6) return null;
    const dd = +s.slice(0, 2);
    const mm = +s.slice(2, 4);
    const yy = +s.slice(4, 6);
    if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yy)) return null;
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
    const year = yy < 80 ? 2000 + yy : 1900 + yy;
    const d = new Date(Date.UTC(year, mm - 1, dd));
    if (d.getUTCDate() !== dd || d.getUTCMonth() !== mm - 1) return null; // 2月31日之类
    return d.toISOString().slice(0, 10);
  }

  function dateToMs(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function msToDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  // ddmm.mmmm（纬度 2 位度 / 经度 3 位度）→ 十进制度，半球决定符号
  function parseLatLon(raw, hemi, isLat) {
    if (!raw || !hemi) return null;
    if (isLat ? (hemi !== 'N' && hemi !== 'S') : (hemi !== 'E' && hemi !== 'W')) return null;
    const degLen = isLat ? 2 : 3;
    if (raw.length <= degLen) return null;
    const deg = +raw.slice(0, degLen);
    const min = +raw.slice(degLen);
    if (!Number.isFinite(deg) || !Number.isFinite(min) || min < 0 || min >= 60) return null;
    const v = deg + min / 60;
    if (isLat && v > 90) return null;
    if (!isLat && v > 180) return null;
    return (hemi === 'S' || hemi === 'W') ? -v : v;
  }

  function numOrNull(s) {
    if (s === '' || s == null) return null;
    const v = +s;
    return Number.isFinite(v) ? v : null;
  }

  /* ---------------- 句子解析 ---------------- */

  // $--RMC,time,status,lat,NS,lon,EW,speed,course,date,mv,mvEW,mode
  function parseRMC(fields) {
    const tod = parseTimeOfDay(fields[1]);
    if (tod === null) return { error: '时间字段缺失或非法' };
    const status = fields[2] || '';
    if (status !== 'A' && status !== 'V') return { error: '定位状态字段非法: ' + (status || '(空)') };
    const date = parseDate(fields[9]);
    const lat = parseLatLon(fields[3], fields[4], true);
    const lon = parseLatLon(fields[5], fields[6], false);
    if (status === 'A') {
      if (lat === null || lon === null) return { error: '状态为定位有效但坐标缺失/非法' };
      if (date === null) return { error: '状态为定位有效但缺少日期字段' };
    }
    return {
      tod, status, date, lat, lon,
      speedKnots: numOrNull(fields[7]),
      courseDeg: numOrNull(fields[8]),
      fixValid: status === 'A', // A 时坐标与日期已保证存在
    };
  }

  // $--GGA,time,lat,NS,lon,EW,quality,sats,hdop,alt,M,geoid,M,dgpsAge,dgpsId
  function parseGGA(fields) {
    const tod = parseTimeOfDay(fields[1]);
    if (tod === null) return { error: '时间字段缺失或非法' };
    const quality = fields[6] === '' ? 0 : +fields[6];
    if (!Number.isFinite(quality) || quality < 0) return { error: '定位质量字段非法' };
    const lat = parseLatLon(fields[2], fields[3], true);
    const lon = parseLatLon(fields[4], fields[5], false);
    if (quality > 0 && (lat === null || lon === null)) {
      return { error: '质量指示为有效定位但坐标缺失/非法' };
    }
    return {
      tod, quality, lat, lon,
      numSats: numOrNull(fields[7]),
      hdop: numOrNull(fields[8]),
      altM: numOrNull(fields[9]),
      fixValid: quality > 0,
    };
  }

  /* ---------------- 时间配对 ---------------- */

  // 有符号"日循环"时差：a-b 折叠到 (-12h, +12h]，用于乱序/跨午夜的安全比较
  function signedDayDiffMs(a, b) {
    let d = (a - b) % DAY_MS;
    if (d < 0) d += DAY_MS;
    if (d >= DAY_MS / 2) d -= DAY_MS;
    return d;
  }

  // GGA 无日期：以 RMC 日期为锚，在 {D-1, D, D+1} 中选使 |Δt| 最小的日期。
  // 只有最小 |Δt| ≤ 配对窗口才允许配对 —— 跨午夜的 GGA 会正确落到前一天或后一天，
  // 而时间差太大的（如上一天早些时候的位置）绝不会被拼到新一天。
  function matchWindow(ggaTod, rmc) {
    const rmcAbs = dateToMs(rmc.date) + rmc.tod;
    let best = null;
    for (let k = -1; k <= 1; k++) {
      const abs = dateToMs(rmc.date) + k * DAY_MS + ggaTod;
      const delta = abs - rmcAbs;
      if (!best || Math.abs(delta) < Math.abs(best.deltaMs)) {
        best = { absGgaMs: abs, deltaMs: delta, dayOffset: k, rmcAbsMs: rmcAbs };
      }
    }
    return best;
  }

  function fmtTod(todMs) {
    const t = ((todMs % DAY_MS) + DAY_MS) % DAY_MS;
    const hh = String(Math.floor(t / 3600000)).padStart(2, '0');
    const mm = String(Math.floor((t % 3600000) / 60000)).padStart(2, '0');
    const ss = ((t % 60000) / 1000).toFixed(1).padStart(4, '0');
    return hh + ':' + mm + ':' + ss;
  }

  /* ---------------- 存储与配对状态机 ---------------- */

  function createStore(opts) {
    opts = opts || {};
    return {
      windowMs: opts.windowMs != null ? opts.windowMs : 2000, // 配对窗口，默认 2 秒
      seq: 0,                    // 接收序号（含被拒绝/重复的行）
      sentences: [],             // 接入明细：全部行（含重复/拒绝/忽略）
      byKey: new Map(),          // 去重键 → 完整句子记录
      poolRMC: new Map(),        // 待配对缓冲池（仅定位有效句）
      poolGGA: new Map(),
      positions: [],             // 配对成功的标准化位置
      positionsById: new Map(),  // 位置 ID → 位置（幂等保证）
      pending: [],               // 待处理区：{sentence, reason, detail, expiredAtSeq}
      stats: {
        lines: 0,        // 接收行数（非空）
        dup: 0,          // 重复（原始句完全相同，已忽略）
        checksumErr: 0,  // 校验和错误
        parseErr: 0,     // 解析失败
        ignored: 0,      // 非 RMC/GGA，按规则忽略
        nofix: 0,        // 无定位状态（RMC=V / GGA质量=0）
        valid: 0,        // 定位有效句
        paired: 0,       // 成功配对数（= 位置数）
      },
    };
  }

  function clearStore(store) {
    const fresh = createStore({ windowMs: store.windowMs });
    for (const k of Object.keys(fresh)) store[k] = fresh[k];
  }

  // 配对成功 → 生成标准化位置记录（幂等：ID 由两句内容哈希决定）
  function makePair(store, rmc, gga, m) {
    const id = 'P-' + rmc.id.slice(1) + '-' + gga.id.slice(1);
    if (store.positionsById.has(id)) return store.positionsById.get(id);
    const posFromGGA = gga.lat !== null && gga.lon !== null;
    const utcMs = posFromGGA ? m.absGgaMs : m.rmcAbsMs;
    const crossNote = m.dayOffset !== 0
      ? '，GGA 日期按 ' + msToDate(m.absGgaMs) + ' 解析（跨午夜：RMC 日期 ' + (m.dayOffset > 0 ? '+' : '') + m.dayOffset + ' 天）'
      : '';
    const rationale =
      'RMC#' + rmc.seq + '（' + rmc.date + ' ' + fmtTod(rmc.tod) + '）× ' +
      'GGA#' + gga.seq + '（' + fmtTod(gga.tod) + crossNote + '），' +
      '|Δt|=' + (Math.abs(m.deltaMs) / 1000).toFixed(2) + 's ≤ 窗口 ' +
      (store.windowMs / 1000).toFixed(1) + 's；位置取自 ' + (posFromGGA ? 'GGA' : 'RMC') +
      '，日期取自 RMC，航速/航向取自 RMC';
    const p = {
      id,
      utcMs,
      iso: new Date(utcMs).toISOString(),
      date: msToDate(utcMs),
      lat: posFromGGA ? gga.lat : rmc.lat,
      lon: posFromGGA ? gga.lon : rmc.lon,
      altM: gga.altM,
      speedKnots: rmc.speedKnots,
      courseDeg: rmc.courseDeg,
      numSats: gga.numSats,
      hdop: gga.hdop,
      posSource: posFromGGA ? 'GGA' : 'RMC',
      deltaMs: m.deltaMs,
      dayOffset: m.dayOffset,
      rmcId: rmc.id, ggaId: gga.id,
      rmcSeq: rmc.seq, ggaSeq: gga.seq,
      rmcRaw: rmc.raw, ggaRaw: gga.raw,
      rationale,
    };
    rmc.state = 'paired'; rmc.pairId = id;
    gga.state = 'paired'; gga.pairId = id;
    store.positions.push(p);
    store.positionsById.set(id, p);
    store.stats.paired++;
    return p;
  }

  // 在对方缓冲池中找 |Δt| 最小且 ≤ 窗口的候选；并列时取先到达者（确定性）
  function findBest(store, s, pool) {
    let best = null;
    for (const other of pool.values()) {
      const m = s.type === 'GGA' ? matchWindow(s.tod, other) : matchWindow(other.tod, s);
      if (Math.abs(m.deltaMs) > store.windowMs) continue;
      if (!best || Math.abs(m.deltaMs) < Math.abs(best.m.deltaMs) ||
          (Math.abs(m.deltaMs) === Math.abs(best.m.deltaMs) && other.seq < best.other.seq)) {
        best = { other, m };
      }
    }
    return best;
  }

  // 过期清扫：新到句子的时刻比池中句子超出窗口（按日循环差，安全处理跨午夜与乱序），
  // 则该池中句子已不可能再配对 → 移入待处理区
  function sweepExpiry(store, newTod) {
    for (const pool of [store.poolRMC, store.poolGGA]) {
      for (const s of Array.from(pool.values())) {
        if (signedDayDiffMs(newTod, s.tod) > store.windowMs) {
          pool.delete(s.key);
          expireToPending(store, s, '数据流推进后仍未等到可配对句');
        }
      }
    }
  }

  function expireToPending(store, s, detail) {
    s.state = 'pending';
    const isGGA = s.type === 'GGA';
    store.pending.push({
      sentence: s,
      reason: isGGA ? '缺少日期' : '配对超时',
      detail: isGGA
        ? 'GGA 本身不含日期字段，' + detail + '，无法确定所属日期'
        : detail + '（RMC 等待对应的 GGA）',
      expiredAtSeq: store.seq,
    });
  }

  // 定位有效句的配对路由（ingest 与 reprocess 共用）
  function routeSentence(store, s) {
    if (!s.fixValid) {
      s.state = 'nofix';
      store.stats.nofix++;
      sweepExpiry(store, s.tod); // 无定位句仍携带流时间，可触发过期
      return { kind: 'nofix', rec: s };
    }
    const myPool = s.type === 'RMC' ? store.poolRMC : store.poolGGA;
    const otherPool = s.type === 'RMC' ? store.poolGGA : store.poolRMC;
    const found = findBest(store, s, otherPool);
    let outcome;
    if (found) {
      otherPool.delete(found.other.key);
      const rmc = s.type === 'RMC' ? s : found.other;
      const gga = s.type === 'RMC' ? found.other : s;
      outcome = { kind: 'paired', position: makePair(store, rmc, gga, found.m) };
    } else {
      s.state = 'pool';
      myPool.set(s.key, s);
      outcome = { kind: 'pool', rec: s };
    }
    sweepExpiry(store, s.tod);
    return outcome;
  }

  /*
   * 接收一行原始文本。处理顺序：去重 → 校验和 → 类型过滤 → 解析 → 无定位分流 → 配对。
   * 返回本次处理结果（供 UI 提示），所有状态写入 store。
   */
  function ingestLine(store, rawLine, receivedAt) {
    const line = String(rawLine).trim();
    if (!line) return null;
    receivedAt = receivedAt == null ? Date.now() : receivedAt;
    store.stats.lines++;

    // 幂等去重：完全相同的原始句只处理一次，重放同一段输入不会产生新记录
    const key = fnv1a(line);
    const dupOf = store.byKey.get(key);
    if (dupOf) {
      store.stats.dup++;
      const rec = { seq: ++store.seq, raw: line, receivedAt, state: 'dup', dupOf: dupOf.id, dupOfSeq: dupOf.seq };
      store.sentences.push(rec);
      return { kind: 'dup', rec };
    }

    // 第一步：校验和
    if (!verifyChecksum(line)) {
      store.stats.checksumErr++;
      const rec = { seq: ++store.seq, raw: line, receivedAt, state: 'checksum_err' };
      store.sentences.push(rec);
      return { kind: 'rejected', rec };
    }

    const body = line.slice(1, line.indexOf('*'));
    const fields = body.split(',');
    const head = fields[0] || '';
    const type = head.slice(-3);
    const talker = head.slice(0, Math.max(0, head.length - 3));

    // 只处理 RMC / GGA，其余句型明确忽略
    if (type !== 'RMC' && type !== 'GGA') {
      store.stats.ignored++;
      const rec = { seq: ++store.seq, raw: line, receivedAt, state: 'ignored', talker, type };
      store.sentences.push(rec);
      return { kind: 'ignored', rec };
    }

    const parsed = type === 'RMC' ? parseRMC(fields) : parseGGA(fields);
    if (parsed.error) {
      store.stats.parseErr++;
      const rec = { seq: ++store.seq, raw: line, receivedAt, state: 'parse_err', talker, type, error: parsed.error };
      store.sentences.push(rec);
      return { kind: 'rejected', rec };
    }

    const s = Object.assign({
      id: 'S' + key, key, parsed: true,
      seq: ++store.seq, raw: line, receivedAt,
      talker, type, state: null, pairId: null,
    }, parsed);
    store.byKey.set(key, s);
    store.sentences.push(s);
    store.stats.valid++;
    return routeSentence(store, s);
  }

  // 数据流结束 / 手动结算：缓冲池中剩余句子全部移入待处理区
  function flushPending(store, why) {
    const detail = why || '数据流结束';
    for (const pool of [store.poolRMC, store.poolGGA]) {
      for (const s of Array.from(pool.values())) {
        pool.delete(s.key);
        expireToPending(store, s, detail);
      }
    }
  }

  // 用当前配对窗口对全部已接收句子重新配对（不清空原始记录；派生数据整体重建，天然幂等）
  function reprocess(store) {
    store.poolRMC.clear();
    store.poolGGA.clear();
    store.positions = [];
    store.positionsById.clear();
    store.pending = [];
    store.stats.paired = 0;
    store.stats.nofix = 0;
    for (const s of store.sentences) {
      if (!s.parsed) continue;
      s.pairId = null;
      routeSentence(store, s);
    }
  }

  function sortedPositions(store) {
    return store.positions.slice().sort((a, b) => a.utcMs - b.utcMs);
  }

  /* ---------------- 导出 ---------------- */

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function positionsToCSV(positions) {
    const head = ['utc_iso', 'date', 'lat_deg', 'lon_deg', 'alt_m', 'speed_kn', 'course_deg',
      'sats', 'hdop', 'pos_source', 'pair_delta_ms', 'pair_id', 'rmc_seq', 'gga_seq', 'pair_rationale'];
    const rows = positions.map(p => [
      p.iso, p.date,
      p.lat.toFixed(7), p.lon.toFixed(7),
      p.altM == null ? '' : p.altM.toFixed(1),
      p.speedKnots == null ? '' : p.speedKnots.toFixed(2),
      p.courseDeg == null ? '' : p.courseDeg.toFixed(1),
      p.numSats == null ? '' : p.numSats,
      p.hdop == null ? '' : p.hdop.toFixed(1),
      p.posSource, Math.round(p.deltaMs), p.id, p.rmcSeq, p.ggaSeq, p.rationale,
    ]);
    return [head].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function positionsToGeoJSON(positions) {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: positions.map(p => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: p.altM == null ? [p.lon, p.lat] : [p.lon, p.lat, p.altM],
        },
        properties: {
          utc_iso: p.iso, date: p.date,
          speed_kn: p.speedKnots, course_deg: p.courseDeg,
          sats: p.numSats, hdop: p.hdop,
          pos_source: p.posSource, pair_delta_ms: Math.round(p.deltaMs),
          pair_id: p.id, rmc_seq: p.rmcSeq, gga_seq: p.ggaSeq,
          pair_rationale: p.rationale,
        },
      })),
    }, null, 2);
  }

  const STATE_LABELS = {
    pool: '缓冲中', paired: '已配对', pending: '待处理', nofix: '无定位',
    dup: '重复', checksum_err: '校验和错误', parse_err: '解析失败', ignored: '已忽略',
  };

  function sentencesToCSV(sentences) {
    const head = ['seq', 'received_at_iso', 'state', 'type', 'raw', 'note'];
    const rows = sentences.map(s => [
      s.seq, new Date(s.receivedAt).toISOString(), STATE_LABELS[s.state] || s.state,
      s.type || '',
      s.raw,
      s.error || (s.pairId ? 'pair=' + s.pairId : '') || (s.dupOf ? 'dup_of=' + s.dupOf : ''),
    ]);
    return [head].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  return {
    DAY_MS,
    checksumOf, verifyChecksum,
    parseTimeOfDay, parseDate, parseLatLon, dateToMs, msToDate, fmtTod,
    signedDayDiffMs, matchWindow,
    createStore, clearStore, ingestLine, flushPending, reprocess, sortedPositions,
    positionsToCSV, positionsToGeoJSON, sentencesToCSV,
    STATE_LABELS,
  };
});
