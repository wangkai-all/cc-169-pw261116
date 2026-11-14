/*
 * generator.js — 合成 NMEA 数据场景发生器。
 * 生成完全虚构的轨迹（不接入任何真实定位设备/地图服务），
 * 输出带正确校验和的 RMC/GGA 句子流，并内置各类异常情形用于演示引擎行为。
 * 浏览器（window.NMEAGenerator）与 Node 双端可用。
 */
(function (root, factory) {
  const E = (typeof module !== 'undefined' && module.exports)
    ? require('./nmea-engine.js')
    : root.NMEAEngine;
  const api = factory(E);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NMEAGenerator = api;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const nmea = (body) => '$' + body + '*' + E.checksumOf(body);

  /* ---------- 虚构轨迹模型：以 (30.0000, 120.0000) 为中心的合成闭合曲线 ---------- */
  const CENTER_LAT = 30.0;
  const CENTER_LON = 120.0;

  function trackAt(absMs) {
    const t = absMs / 1000;
    const w1 = (2 * Math.PI) / 240; // 4 分钟一圈
    const w2 = (2 * Math.PI) / 180;
    return {
      lat: CENTER_LAT + 0.008 * Math.sin(w1 * t),
      lon: CENTER_LON + 0.012 * Math.sin(w2 * t + Math.PI / 4),
      alt: 45 + 12 * Math.sin((2 * Math.PI / 120) * t),
      sats: 7 + Math.floor(4 * (0.5 + 0.5 * Math.sin((2 * Math.PI / 90) * t))),
      hdop: 0.8 + 0.6 * (0.5 + 0.5 * Math.sin((2 * Math.PI / 75) * t)),
    };
  }

  // 由相邻两秒位置推算航速（节）与航向（度）
  function motionAt(absMs) {
    const a = trackAt(absMs - 1000);
    const b = trackAt(absMs);
    const dy = (b.lat - a.lat) * 110540;
    const dx = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    const speedKn = (Math.hypot(dx, dy) / 1.852); // m/s → kn（每秒 1 个历元）
    let course = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (course < 0) course += 360;
    return { speedKn, course };
  }

  function fmtLat(lat) {
    const hemi = lat < 0 ? 'S' : 'N';
    const a = Math.abs(lat);
    let deg = Math.floor(a);
    let min = +((a - deg) * 60).toFixed(4); // 先修约再进位，避免 59.99996 → 60.0000
    if (min >= 60) { deg += 1; min = 0; }
    return [String(deg).padStart(2, '0') + min.toFixed(4).padStart(7, '0'), hemi];
  }

  function fmtLon(lon) {
    const hemi = lon < 0 ? 'W' : 'E';
    const a = Math.abs(lon);
    let deg = Math.floor(a);
    let min = +((a - deg) * 60).toFixed(4);
    if (min >= 60) { deg += 1; min = 0; }
    return [String(deg).padStart(3, '0') + min.toFixed(4).padStart(7, '0'), hemi];
  }

  function fmtTime(absMs) {
    const tod = ((absMs % E.DAY_MS) + E.DAY_MS) % E.DAY_MS;
    const hh = String(Math.floor(tod / 3600000)).padStart(2, '0');
    const mm = String(Math.floor((tod % 3600000) / 60000)).padStart(2, '0');
    const ss = ((tod % 60000) / 1000).toFixed(1).padStart(4, '0');
    return hh + mm + ss;
  }

  function fmtDate(absMs) {
    const d = new Date(absMs);
    return String(d.getUTCDate()).padStart(2, '0') +
           String(d.getUTCMonth() + 1).padStart(2, '0') +
           String(d.getUTCFullYear() % 100).padStart(2, '0');
  }

  function rmcLine(absMs, fix) {
    const p = trackAt(absMs);
    const m = motionAt(absMs);
    if (!fix) {
      return nmea(`GPRMC,${fmtTime(absMs)},V,,,,,,,${fmtDate(absMs)},,,N`);
    }
    const [lat, ns] = fmtLat(p.lat);
    const [lon, ew] = fmtLon(p.lon);
    return nmea(`GPRMC,${fmtTime(absMs)},A,${lat},${ns},${lon},${ew},${m.speedKn.toFixed(1)},${m.course.toFixed(1)},${fmtDate(absMs)},,,A`);
  }

  function ggaLine(absMs, fix) {
    const p = trackAt(absMs);
    if (!fix) {
      return nmea(`GPGGA,${fmtTime(absMs)},,,,,0,00,,,,M,,M,,`);
    }
    const [lat, ns] = fmtLat(p.lat);
    const [lon, ew] = fmtLon(p.lon);
    return nmea(`GPGGA,${fmtTime(absMs)},${lat},${ns},${lon},${ew},1,${String(p.sats).padStart(2, '0')},${p.hdop.toFixed(1)},${p.alt.toFixed(1)},M,18.5,M,,`);
  }

  /* ---------- 场景装配 ---------- */
  // 每个场景返回 { name, description, lines: [{t: 相对毫秒, line}] }
  // startDate: 'YYYY-MM-DD'；startTodMs: 起始当日时刻

  function buildEpochs(startDate, startTodMs, count, stepMs, emit) {
    const lines = [];
    const base = E.dateToMs(startDate) + startTodMs;
    for (let i = 0; i < count; i++) {
      emit(base + i * stepMs, i, lines);
    }
    lines.sort((a, b) => a.t - b.t);
    return lines;
  }

  const TOD_0800 = 8 * 3600000;
  const TOD_235950 = 23 * 3600000 + 59 * 60000 + 50000;

  const SCENARIOS = {
    basic: {
      name: '基础巡航（60 历元，有序）',
      description: '1Hz 标准流：每秒一对 RMC+GGA，按序到达，全程定位有效。',
      build(startDate) {
        return buildEpochs(startDate, TOD_0800, 60, 1000, (abs, i, out) => {
          out.push({ t: i * 1000, line: rmcLine(abs, true) });
          out.push({ t: i * 1000 + 120, line: ggaLine(abs, true) });
        });
      },
    },

    midnight: {
      name: '午夜跨日（23:59:50 → 次日 00:00:29）',
      description: '数据流跨越午夜：RMC 日期在途中翻页，GGA 无日期，由配对逻辑按"时间差最小"原则为 GGA 选定日期。23:59:59 的 GGA 与 00:00:00 的 RMC 被刻意抽走，使二者跨日配对（位置正确落到次日），演示跨午夜处理。',
      build(startDate) {
        return buildEpochs(startDate, TOD_235950, 40, 1000, (abs, i, out) => {
          const skipGGA = i === 9;  // 23:59:59 的 GGA 缺失
          const skipRMC = i === 10; // 00:00:00 的 RMC 缺失 → 两句跨日互配
          if (!skipRMC) out.push({ t: i * 1000, line: rmcLine(abs, true) });
          if (!skipGGA) out.push({ t: i * 1000 + 120, line: ggaLine(abs, true) });
        });
      },
    },

    disorder: {
      name: '乱序到达（含一对超窗）',
      description: '部分 GGA 先于同历元 RMC 到达（窗口内正常配对）；最后一对的 GGA 时间戳偏移 3.5s，超出默认 2s 窗口 → 待处理区，调大窗口并重新配对可恢复。',
      build(startDate) {
        return buildEpochs(startDate, TOD_0800, 40, 1000, (abs, i, out) => {
          if (i === 39) { // 最后一对：GGA 时间戳比 RMC 晚 3.5s
            out.push({ t: i * 1000, line: rmcLine(abs, true) });
            out.push({ t: i * 1000 + 3500, line: ggaLine(abs + 3500, true) });
          } else if (i % 3 === 0) { // GGA 先到
            out.push({ t: i * 1000, line: ggaLine(abs, true) });
            out.push({ t: i * 1000 + 150, line: rmcLine(abs, true) });
          } else {
            out.push({ t: i * 1000, line: rmcLine(abs, true) });
            out.push({ t: i * 1000 + 150, line: ggaLine(abs, true) });
          }
        });
      },
    },

    nofix: {
      name: '无定位间隙（中段 10 秒丢星）',
      description: '中段 10 个历元 RMC 状态=V、GGA 质量=0：明确归类为"无定位"，不进配对池、不产生位置。',
      build(startDate) {
        return buildEpochs(startDate, TOD_0800, 50, 1000, (abs, i, out) => {
          const fix = !(i >= 20 && i < 30);
          out.push({ t: i * 1000, line: rmcLine(abs, fix) });
          out.push({ t: i * 1000 + 120, line: ggaLine(abs, fix) });
        });
      },
    },

    missing: {
      name: '缺失配对（单边句 → 待处理区）',
      description: '第 10–14 历元只有 RMC、第 20–23 历元只有 GGA。无法配对的落单句进入待处理区（RMC=配对超时，GGA=缺少日期）。注意：默认 2s 窗口下，缺口之后的句子会按"最近邻"规则与相邻历元配对（位置表可见一串 Δt=1s）；将窗口调至 1s 以下并重新配对可消除这种跨历元配对。',
      build(startDate) {
        return buildEpochs(startDate, TOD_0800, 40, 1000, (abs, i, out) => {
          const skipGGA = i >= 10 && i <= 14;
          const skipRMC = i >= 20 && i <= 23;
          if (!skipRMC) out.push({ t: i * 1000, line: rmcLine(abs, true) });
          if (!skipGGA) out.push({ t: i * 1000 + 120, line: ggaLine(abs, true) });
        });
      },
    },

    combined: {
      name: '综合演练（全部异常 + 错误句 + 重复）',
      description: '混合：乱序、无定位间隙、缺失配对、校验和错误、截断句、非 RMC/GGA 句型、整段重复（演示幂等去重）。',
      build(startDate) {
        const lines = buildEpochs(startDate, TOD_0800, 60, 1000, (abs, i, out) => {
          const fix = !(i >= 30 && i < 35); // 30–34 无定位
          const skipGGA = i >= 40 && i <= 43; // RMC 落单（中间两句进待处理区）
          const skipRMC = i >= 50 && i <= 52; // GGA 落单（中间两句进待处理区）
          if (i === 5) {
            out.push({ t: i * 1000 - 400, line: nmea('GPVTG,120.5,T,,M,3.2,N,5.9,K,A') }); // 非目标句型
            out.push({ t: i * 1000 - 300, line: nmea('GPGSV,3,1,12,01,40,083,45,02,17,308,41') }); // 非目标句型
          }
          if (i === 25) { // 校验和错误：篡改载荷不重算
            out.push({ t: i * 1000, line: rmcLine(abs, fix).replace(',A,', ',A,9') });
            out.push({ t: i * 1000 + 120, line: ggaLine(abs, fix) });
            return;
          }
          if (i === 26) { // 截断句：无校验和
            out.push({ t: i * 1000, line: '$GPRMC,' + fmtTime(abs) + ',A,3012.3456,N' });
            out.push({ t: i * 1000 + 120, line: ggaLine(abs, fix) });
            return;
          }
          if (i % 4 === 1) { // 乱序：GGA 先到
            if (!skipGGA) out.push({ t: i * 1000, line: ggaLine(abs, fix) });
            if (!skipRMC) out.push({ t: i * 1000 + 150, line: rmcLine(abs, fix) });
          } else {
            if (!skipRMC) out.push({ t: i * 1000, line: rmcLine(abs, fix) });
            if (!skipGGA) out.push({ t: i * 1000 + 150, line: ggaLine(abs, fix) });
          }
        });
        // 末尾整段重复第 8–12 历元的句子（原样重发 → 应全部被去重）
        const dupBlock = lines.filter(l => l.t >= 8000 && l.t < 13000)
          .map(l => ({ t: l.t + 52000, line: l.line }));
        return lines.concat(dupBlock).sort((a, b) => a.t - b.t);
      },
    },
  };

  function listScenarios() {
    return Object.entries(SCENARIOS).map(([key, s]) => ({ key, name: s.name, description: s.description }));
  }

  function buildScenario(key, startDate) {
    const s = SCENARIOS[key];
    if (!s) throw new Error('未知场景: ' + key);
    return { key, name: s.name, description: s.description, lines: s.build(startDate) };
  }

  return { listScenarios, buildScenario, trackAt };
});
