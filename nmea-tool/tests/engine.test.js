/*
 * engine.test.js — NMEA 配对引擎行为测试（Node 直接运行，无框架）
 * 运行：node tests/engine.test.js
 */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'nmea-engine.js'));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, `期望 ${b}，实际 ${a}`); }
function group(name) { console.log('\n[' + name + ']'); }

// 造句工具
const nmea = (body) => '$' + body + '*' + E.checksumOf(body);
const RMC = (time, status, lat, ns, lon, ew, date) =>
  nmea(`GPRMC,${time},${status},${lat},${ns},${lon},${ew},10.5,90.0,${date},,,A`);
const GGA = (time, lat, ns, lon, ew, q) =>
  nmea(`GPGGA,${time},${lat},${ns},${lon},${ew},${q},08,1.0,50.0,M,,M,,`);

/* ---------- 校验和 ---------- */
group('校验和');
{
  const good = RMC('120000.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126');
  ok(E.verifyChecksum(good), '合法句子通过校验');
  ok(!E.verifyChecksum(good.replace('3000', '3001')), '篡改载荷后校验失败');
  ok(!E.verifyChecksum(good.slice(0, -2) + '00'), '错误校验和被拒绝');
  ok(!E.verifyChecksum('$GPRMC,120000.0,A'), '缺少 * 与校验和 → 失败');
  ok(!E.verifyChecksum('GPRMC,120000.0,A*1A'), '缺少 $ → 失败');
}

/* ---------- 解析与经纬度换算 ---------- */
group('解析与经纬度换算');
{
  eq(E.parseTimeOfDay('235959.5'), 86399500, 'hhmmss.s → 当日毫秒');
  eq(E.parseTimeOfDay('246000'), null, '非法时间被拒绝');
  eq(E.parseDate('151126'), '2026-11-15', 'ddmmyy → 日期');
  eq(E.parseDate('311299'), '1999-12-31', 'yy≥80 → 19xx');
  eq(E.parseDate('310226'), null, '2月31日被拒绝');
  const lat = E.parseLatLon('3007.5000', 'N', true);
  ok(Math.abs(lat - 30.125) < 1e-9, '北纬 ddmm.mmmm → 十进制');
  ok(E.parseLatLon('3007.5000', 'S', true) === -lat, '南纬为负');
  ok(E.parseLatLon('12030.0000', 'W', false) === -120.5, '西经为负');
  eq(E.parseLatLon('9100.0000', 'N', true), null, '纬度 >90° 被拒绝');
  eq(E.parseLatLon('1260.0000', 'N', true), null, '分 ≥60 被拒绝');
  eq(E.parseLatLon('3000.0000', 'E', true), null, '纬度用 E/W 半球被拒绝');
}

/* ---------- 基础配对 ---------- */
group('基础配对');
{
  const st = E.createStore({ windowMs: 2000 });
  E.ingestLine(st, RMC('080000.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1000);
  const out = E.ingestLine(st, GGA('080000.2', '3000.0060', 'N', '12000.0060', 'E', '1'), 1100);
  eq(out.kind, 'paired', 'RMC+GGA 配对成功');
  eq(st.positions.length, 1, '生成 1 条位置');
  const p = st.positions[0];
  eq(p.date, '2026-11-15', '日期取自 RMC');
  ok(Math.abs(p.lat - 30.0001) < 1e-9, '位置取自 GGA 坐标');
  eq(p.posSource, 'GGA', '位置来源标记为 GGA');
  eq(p.speedKnots, 10.5, '航速取自 RMC');
  eq(p.altM, 50, '海拔取自 GGA');
  ok(p.rationale.includes('|Δt|=0.20s'), '配对依据含时间差');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(p.iso), 'UTC 时间戳为 ISO 格式');
}

/* ---------- 乱序到达 ---------- */
group('乱序到达');
{
  const st = E.createStore({ windowMs: 2000 });
  E.ingestLine(st, GGA('090000.0', '3000.0000', 'N', '12000.0000', 'E', '1'), 1000); // GGA 先到
  const out = E.ingestLine(st, RMC('090000.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 2000);
  eq(out.kind, 'paired', 'GGA 先到时 RMC 到达即配对');
  eq(st.positions.length, 1, '乱序在窗口内仍生成位置');
}

/* ---------- 配对超时与缺少日期 → 待处理区 ---------- */
group('待处理区');
{
  const st = E.createStore({ windowMs: 2000 });
  E.ingestLine(st, RMC('100000.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1000);
  E.ingestLine(st, GGA('100000.0', '3000.0000', 'N', '12000.0000', 'E', '1'), 1100); // 与 RMC 配对
  E.ingestLine(st, RMC('100010.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1200); // 落单（±2s 内无 GGA）
  E.ingestLine(st, GGA('100020.0', '3000.0000', 'N', '12000.0000', 'E', '1'), 1300); // 落单；同时触发上一句过期
  E.ingestLine(st, RMC('100030.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1400); // 触发 GGA 过期
  E.ingestLine(st, GGA('100030.0', '3000.0000', 'N', '12000.0000', 'E', '1'), 1500); // 配对
  E.ingestLine(st, RMC('100040.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1600); // 留在缓冲池
  eq(st.pending.length, 2, '落单两句进入待处理区');
  eq(st.pending[0].reason, '配对超时', '落单 RMC 原因=配对超时');
  eq(st.pending[1].reason, '缺少日期', '落单 GGA 原因=缺少日期');
  E.flushPending(st, '数据流结束');
  eq(st.pending.length, 3, '流结束时缓冲池剩余句结算');
  eq(st.pending[2].sentence.type, 'RMC', '结算的是最后的 RMC');
}

/* ---------- 午夜跨日 ---------- */
group('午夜跨日');
{
  // 情形1：RMC 在 23:59:59（日期 D），GGA 在 00:00:01 → GGA 属于 D+1
  const st1 = E.createStore({ windowMs: 2000 });
  E.ingestLine(st1, RMC('235959.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1000);
  const out1 = E.ingestLine(st1, GGA('000001.0', '3000.0060', 'N', '12000.0060', 'E', '1'), 1100);
  eq(out1.kind, 'paired', '23:59:59 的 RMC 与 00:00:01 的 GGA 跨日配对');
  eq(st1.positions[0].date, '2026-11-16', '跨午夜 GGA 位置归到新一天');
  eq(st1.positions[0].dayOffset, 1, 'dayOffset=+1');
  ok(st1.positions[0].rationale.includes('跨午夜'), '配对依据注明跨午夜');

  // 情形2：GGA 在 23:59:59 先到，RMC 在 00:00:01（日期 D+1）→ GGA 属于 D
  const st2 = E.createStore({ windowMs: 2000 });
  E.ingestLine(st2, GGA('235959.0', '3000.0000', 'N', '12000.0000', 'E', '1'), 1000);
  const out2 = E.ingestLine(st2, RMC('000001.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '161126'), 1100);
  eq(out2.kind, 'paired', '00:00:01 的 RMC 与前一日 23:59:59 的 GGA 配对');
  eq(st2.positions[0].date, '2026-11-15', '位置留在前一天，不拼到新一天');
  eq(st2.positions[0].dayOffset, -1, 'dayOffset=-1');

  // 情形3：上一天的位置绝不能拼到新一天（时间差远超窗口）
  const st3 = E.createStore({ windowMs: 2000 });
  E.ingestLine(st3, RMC('230000.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1000);
  const out3 = E.ingestLine(st3, GGA('000005.0', '3000.0000', 'N', '12000.0000', 'E', '1'), 1100);
  ok(out3.kind !== 'paired', '相差 1 小时不配对');
  E.flushPending(st3);
  eq(st3.positions.length, 0, '无跨日拼接位置');
  eq(st3.pending.filter(x => x.reason === '缺少日期').length, 1, 'GGA 因缺少日期进入待处理区');
}

/* ---------- 无定位状态 ---------- */
group('无定位状态');
{
  const st = E.createStore({ windowMs: 2000 });
  const o1 = E.ingestLine(st, RMC('110000.0', 'V', '', '', '', '', '151126'), 1000);
  const o2 = E.ingestLine(st, GGA('110000.0', '', '', '', '', '0'), 1100);
  eq(o1.kind, 'nofix', 'RMC 状态 V → 无定位');
  eq(o2.kind, 'nofix', 'GGA 质量 0 → 无定位');
  eq(st.positions.length, 0, '无定位不产生位置');
  eq(st.poolRMC.size + st.poolGGA.size, 0, '无定位句不进配对池');
  eq(st.stats.nofix, 2, '无定位计数');
  E.flushPending(st);
  eq(st.pending.length, 0, '无定位句不进待处理区（已有明确归类）');
}

/* ---------- 错误与忽略 ---------- */
group('错误与忽略');
{
  const st = E.createStore();
  E.ingestLine(st, '$GPRMC,120000.0,A,3000.0000,N,12000.0000,E,10.5,90.0,151126,,,A*00', 1000);
  eq(st.stats.checksumErr, 1, '校验和错误计数');
  E.ingestLine(st, nmea('GPVTG,90.0,T,,M,10.5,N,19.4,K,A'), 1100);
  eq(st.stats.ignored, 1, '非 RMC/GGA 句型被忽略');
  E.ingestLine(st, nmea('GPRMC,999999.0,A,3000.0000,N,12000.0000,E,10.5,90.0,151126,,,A'), 1200);
  eq(st.stats.parseErr, 1, '非法时间 → 解析失败');
  E.ingestLine(st, nmea('GPRMC,120000.0,A,,,,,,,151126,,,A'), 1300);
  eq(st.stats.parseErr, 2, '状态 A 但坐标缺失 → 解析失败');
  eq(st.positions.length, 0, '错误句不产生位置');
}

/* ---------- 幂等：重放同一段输入 ---------- */
group('幂等去重');
{
  const st = E.createStore({ windowMs: 2000 });
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const hhmmss = '08' + String(i).padStart(2, '0') + '00.0';
    lines.push(RMC(hhmmss, 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'));
    lines.push(GGA(hhmmss, '3000.0000', 'N', '12000.0000', 'E', '1'));
  }
  lines.forEach((l, i) => E.ingestLine(st, l, 1000 + i * 100));
  eq(st.positions.length, 10, '首次播放生成 10 个位置');
  const before = st.positions.length;
  lines.forEach((l, i) => E.ingestLine(st, l, 9000 + i * 100)); // 整段重放
  eq(st.positions.length, before, '重放同一段输入不重复生成位置');
  eq(st.stats.dup, lines.length, '重放的句子全部计为重复');
  eq(st.pending.length, 0, '重放不产生新的待处理记录');
}

/* ---------- 窗口调整 + 重新配对 ---------- */
group('窗口调整与重新配对');
{
  const st = E.createStore({ windowMs: 2000 });
  E.ingestLine(st, RMC('120000.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1000);
  E.ingestLine(st, GGA('120003.5', '3000.0000', 'N', '12000.0000', 'E', '1'), 1100); // 差 3.5s > 默认窗口
  E.ingestLine(st, RMC('120010.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1200); // 触发过期
  eq(st.positions.length, 0, '3.5s 超出 2s 窗口，不配对');
  eq(st.pending.length, 2, '两句进入待处理区');
  st.windowMs = 5000;
  E.reprocess(st);
  eq(st.positions.length, 1, '窗口放宽到 5s 并重新配对后成功');
  eq(st.pending.length, 0, '重新配对后待处理区清空重建');
  eq(st.poolRMC.size, 1, '剩余 1 句仍在缓冲池（流未结束）');
  E.flushPending(st, '数据流结束');
  eq(st.pending.length, 1, '结算后进入待处理区');
  E.reprocess(st);
  eq(st.positions.length, 1, '重复 reprocess 幂等，不翻倍');
}

/* ---------- 导出 ---------- */
group('导出');
{
  const st = E.createStore();
  E.ingestLine(st, RMC('080000.0', 'A', '3000.0000', 'N', '12000.0000', 'E', '151126'), 1000);
  E.ingestLine(st, GGA('080000.0', '3000.0000', 'N', '12000.0000', 'E', '1'), 1100);
  const pos = E.sortedPositions(st);
  const csv = E.positionsToCSV(pos);
  ok(csv.startsWith('utc_iso,'), 'CSV 含表头');
  ok(csv.includes('2026-11-15T08:00:00.000Z'), 'CSV 含 UTC 时间');
  ok(csv.includes('RMC#1'), 'CSV 含配对依据');
  const fake = [{ iso: 'x', date: 'd', lat: 1, lon: 2, altM: null, speedKnots: null, courseDeg: null,
    numSats: null, hdop: null, posSource: 'GGA', deltaMs: 0, id: 'P', rmcSeq: 1, ggaSeq: 2, rationale: 'a,b' }];
  ok(E.positionsToCSV(fake).includes('"a,b"'), '含 ASCII 逗号的字段正确加引号');
  const gj = JSON.parse(E.positionsToGeoJSON(pos));
  eq(gj.type, 'FeatureCollection', 'GeoJSON 类型正确');
  eq(gj.features[0].geometry.coordinates[0], 120, 'GeoJSON 经度在前');
  const scsv = E.sentencesToCSV(st.sentences);
  ok(scsv.includes('$GPRMC'), '接入明细导出含原始句');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
