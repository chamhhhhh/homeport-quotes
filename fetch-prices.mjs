// Homeport 行情抓取脚本 v5 · 跑在 GitHub Actions 上
// 股票/ETF：东方财富 push2（备用腾讯 GBK）
// 场外基金净值：天天基金 fundgz（自带名称校验，代码配错会被剔除并列入 fund_issues）
// 红利股周线布林（723撒网用）：东财 push2his 周K → BOLL(20,2) + %B
// 输出 prices.json：{ updated, source, prices:{代码:{name,price}}, funds:{代码:{name,nav,date}}, boll:{代码:{mid,up,low,pb,close,date}}, fund_issues:[] }

const CODES = [
  ["1", "600036", "招商银行"], ["1", "600887", "伊利股份"], ["1", "600941", "中国移动"],
  ["1", "601919", "中远海控"], ["1", "601985", "中国核电"], ["0", "003816", "中国广核"],
  ["1", "518880", "黄金ETF华安"], ["0", "000538", "云南白药"], ["0", "159841", "证券ETF天弘"],
  ["1", "512480", "半导体ETF"], ["1", "512000", "券商ETF"], ["1", "600938", "中国海油"],
  ["1", "513050", "中概互联"], ["1", "601318", "中国平安"], ["0", "000423", "东阿阿胶"],
  ["1", "600886", "国投电力"], ["1", "516880", "光伏50"], ["1", "601857", "中国石油"],
  ["1", "601728", "中国电信"], ["1", "600011", "华能国际"], ["1", "600795", "国电电力"],
  ["0", "159934", "黄金ETF易方达"], ["1", "512660", "军工ETF"],
  ["116", "01024", "快手-W"], // 港股，用于快手RSU估值
];

// 场外基金（全部已核实代码，2026-07-11）
// 投顾组合（如海外长钱）没有统一净值，不在此列，人工更新
const FUNDS = [
  ["160119", "南方中证500ETF联接"],
  ["110020", "易方达沪深300ETF联接A"],
  ["090010", "大成中证红利指数A"],
  ["008163", "南方红利低波50ETF联接A"],
  ["100032", "富国中证红利指数增强A"],
  ["000968", "广发养老指数A"],
  ["001717", "工银前沿医疗股票A"],
  ["161039", "富国中证1000指数增强(LOF)A"],
  ["161017", "富国中证500指数增强(LOF)A"],
  ["110003", "易方达上证50指数增强A"],
  ["164906", "交银中证海外中国互联网(QDII-LOF)"],
  ["001618", "天弘中证电子ETF联接C"],
  ["005223", "广发中证基建工程ETF联接A"],
  ["000051", "华夏沪深300ETF联接A"],
  ["160633", "鹏华中证全指证券公司指数(LOF)A"],
  ["001052", "华夏中证500ETF联接A"],
  ["000478", "建信中证500指数增强A"],
  ["161725", "招商中证白酒指数(LOF)A"],
  ["110017", "易方达增强回报债券A"],
  ["217022", "招商产业债券A"],
  ["009951", "广发稳健回报混合A"],
  ["016452", "南方纳斯达克100指数发起(QDII)A"],
  ["539001", "建信纳斯达克100指数(QDII)A人民币"],
  ["003156", "招商招悦纯债A"],
  ["400030", "东方添益债券"],
  ["010353", "南方崇元纯债债券A"],
  ["001751", "华商信用增强债券A"],
  ["006549", "国金惠盈纯债A"],
  ["008383", "招商安心收益债券A"],
  ["008974", "长城稳健增利债券C"],
  ["485119", "工银信用纯债债券A"],
  ["004419", "汇添富美元债债券(QDII)人民币A"],
];

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const norm = s => String(s).replace(/[ＡａA]$/,"A").replace(/[（(].*?[)）]/g, "").replace(/[指数联接ETF基金债券混合股票LOFQDII\s]/g, "");

async function fromEastmoney() {
  const secids = CODES.map(([m, c]) => `${m}.${c}`).join(",");
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f12,f14`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("eastmoney http " + res.status);
  const j = await res.json();
  const diff = j?.data?.diff;
  const list = Array.isArray(diff) ? diff : Object.values(diff || {});
  const prices = {};
  for (const d of list) {
    const p = Number(d.f2);
    if (d.f12 && p > 0) prices[d.f12] = { name: d.f14, price: p };
  }
  if (Object.keys(prices).length < CODES.length * 0.8) throw new Error("eastmoney too few rows");
  return { source: "eastmoney", prices };
}

async function fromTencent() {
  const q = CODES.map(([m, c]) => (m === "116" ? "hk" : m === "1" ? "sh" : "sz") + c).join(",");
  const res = await fetch(`https://qt.gtimg.cn/q=${q}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("tencent http " + res.status);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buf);
  const prices = {};
  for (const line of text.split(";")) {
    const m = line.match(/v_(?:sh|sz|hk)(\d{5,6})="([^"]+)"/);
    if (!m) continue;
    const f = m[2].split("~");
    const p = Number(f[3]);
    if (p > 0) prices[m[1]] = { name: f[1], price: p };
  }
  if (Object.keys(prices).length < CODES.length * 0.8) throw new Error("tencent too few rows");
  return { source: "tencent", prices };
}

async function fetchFundNav(code) {
  // 主接口：估值接口（含昨日净值）；QDII 等无估值的基金走备用历史净值接口
  try {
    const res = await fetch(`https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://fund.eastmoney.com/" },
    });
    if (res.ok) {
      const text = await res.text();
      const m = text.match(/jsonpgz\((\{.*\})\)/);
      if (m) {
        const j = JSON.parse(m[1]);
        if (Number(j.dwjz) > 0) return { name: j.name, nav: Number(j.dwjz), date: j.jzrq };
      }
    }
  } catch (e) {}
  // 备用：f10 历史净值（覆盖 QDII）
  const res2 = await fetch(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1&_=${Date.now()}`, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` },
  });
  if (!res2.ok) throw new Error("f10 http " + res2.status);
  const j2 = await res2.json();
  const row = j2?.Data?.LSJZList?.[0];
  if (!row || !(Number(row.DWJZ) > 0)) throw new Error("no data");
  // f10 不返回名称，无法校验——标记来源，名称沿用预期值
  return { name: null, nav: Number(row.DWJZ), date: row.FSRQ, via_f10: true };
}

async function fetchUsdCny() {
  try {
    const res = await fetch("https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid=133.USDCNH&fields=f43,f58", { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await res.json();
    let v = Number(j?.data?.f43);
    if (v > 100) v = v / 10000;
    if (v > 5 && v < 10) return Math.round(v * 10000) / 10000;
  } catch (e) {}
  return null;
}

async function fetchHkdCny() {
  try {
    const res = await fetch("https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid=133.HKDCNH&fields=f43,f58", { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await res.json();
    let v = Number(j?.data?.f43);
    if (v > 100) v = v / 10000;
    if (v > 0.5 && v < 1.5) return Math.round(v * 10000) / 10000;
  } catch (e) {}
  return null;
}

// —— 红利股周线布林（20周·2σ），dashboard 723撒网 弹窗的确认灯用 ——
// %B = (最新周收盘 − 下轨) / (上轨 − 下轨)：≤0.2 近下轨、≥0.8 近上轨
const BOLL_SET = new Set([
  "600036", "600887", "600941", "601919", "601985", "003816", "000538", "600938",
  "601318", "000423", "600886", "601857", "601728", "600011", "600795",
]);
async function weeklyClosesEastmoney(mkt, code) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${mkt}.${code}&klt=102&fqt=1&lmt=25&end=20500101&fields1=f1,f2,f3&fields2=f51,f53`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("kline http " + res.status);
  const j = await res.json();
  const ks = j?.data?.klines;
  if (!Array.isArray(ks) || ks.length < 20) throw new Error("kline rows " + (ks ? ks.length : 0));
  return ks.map(l => ({ date: l.split(",")[0], close: Number(l.split(",")[1]) }));
}
async function weeklyClosesTencent(mkt, code) {
  const sym = (mkt === "1" ? "sh" : "sz") + code;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},week,,,25,qfq`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("tx kline http " + res.status);
  const j = await res.json();
  const d = j?.data?.[sym];
  const ks = (d && (d.qfqweek || d.week)) || [];
  if (!Array.isArray(ks) || ks.length < 20) throw new Error("tx kline rows " + ks.length);
  return ks.map(k => ({ date: k[0], close: Number(k[2]) }));
}
async function fetchWeeklyBoll(mkt, code) {
  let ks;
  try { ks = await weeklyClosesEastmoney(mkt, code); }
  catch (e) { ks = await weeklyClosesTencent(mkt, code); }
  const rows = ks.filter(k => k.close > 0).slice(-20);
  if (rows.length < 20) throw new Error("bad closes");
  const closes = rows.map(k => k.close);
  const mid = closes.reduce((s, v) => s + v, 0) / 20;
  const sd = Math.sqrt(closes.reduce((s, v) => s + (v - mid) ** 2, 0) / 20);
  const up = mid + 2 * sd, low = mid - 2 * sd;
  const last = closes[closes.length - 1];
  const pb = up > low ? (last - low) / (up - low) : null;
  return { mid: +mid.toFixed(3), up: +up.toFixed(3), low: +low.toFixed(3),
    pb: pb == null ? null : +pb.toFixed(3), close: last, date: rows[rows.length - 1].date };
}

let result;
try { result = await fromEastmoney(); }
catch (e) { console.error("eastmoney failed:", e.message); result = await fromTencent(); }

const boll = {};
for (const [m, c, n] of CODES) {
  if (!BOLL_SET.has(c)) continue;
  try { boll[c] = await fetchWeeklyBoll(m, c); }
  catch (e) { console.warn("boll failed:", c, n, e.message); }
  await new Promise(r => setTimeout(r, 300));
}

const usd = await fetchUsdCny();
if (usd) result.prices["USDT"] = { name: "USDT≈USD/CNH", price: usd };
const hkd = await fetchHkdCny();
if (hkd) result.prices["HKD"] = { name: "港币汇率(CNY)", price: hkd };

const funds = {}, fund_issues = [];
for (const [code, expect] of FUNDS) {
  if (!code) { fund_issues.push(`待补代码: ${expect}`); continue; }
  // v5.1: 偶发 fetch failed（008163/004419 常中招）——失败自动重试，最多3次
  let f = null, lastErr = null;
  for (let att = 1; att <= 3 && !f; att++) {
    try { f = await fetchFundNav(code); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500 * att)); }
  }
  if (!f) { fund_issues.push(`抓取失败: ${code} ${expect} (${lastErr && lastErr.message})`); continue; }
  if (f.name != null) {
    const a = norm(f.name), b = norm(expect);
    if (!(a.includes(b.slice(0, 4)) || b.includes(a.slice(0, 4)))) {
      fund_issues.push(`名称不匹配: ${code} 预期「${expect}」实际「${f.name}」`);
      continue;
    }
  }
  funds[code] = { name: expect, api_name: f.name || "(f10无名称校验)", nav: f.nav, date: f.date };
  await new Promise(r => setTimeout(r, 300));
}

const missing = CODES.filter(([, c]) => !result.prices[c]).map(([, c, n]) => `${c} ${n}`);
if (missing.length) console.warn("stock missing:", missing.join(", "));
if (fund_issues.length) console.warn("fund issues:\n" + fund_issues.join("\n"));

writeFileSync("prices.json", JSON.stringify({
  updated: new Date().toISOString(),
  source: result.source,
  prices: result.prices,
  funds,
  boll,
  fund_issues,
}, null, 2));
// —— history.json：每日快照追加（供 dashboard 画总资产按天趋势）——
// 结构 { updated, days:[ { date, prices:{代码:收盘价}, funds:{代码:净值} }, ... ] }
// 同日重跑覆盖当日；最多保留 750 天
const bjDate = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京时间日期
let days = [];
if (existsSync("history.json")) {
  try { days = JSON.parse(readFileSync("history.json", "utf8")).days || []; } catch (e) {}
}
const slimPrices = {}, slimFunds = {};
for (const c in result.prices) slimPrices[c] = result.prices[c].price;
for (const c in funds) slimFunds[c] = funds[c].nav;
days = days.filter(d => d.date !== bjDate);
days.push({ date: bjDate, prices: slimPrices, funds: slimFunds });
days.sort((a, b) => (a.date < b.date ? -1 : 1));
if (days.length > 750) days = days.slice(-750);
writeFileSync("history.json", JSON.stringify({ updated: new Date().toISOString(), days }));

console.log(`ok: ${Object.keys(result.prices).length} stocks, ${Object.keys(funds).length} funds, ${Object.keys(boll).length} boll, ${fund_issues.length} issues, history ${days.length} days`);
