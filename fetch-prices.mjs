// Homeport 行情抓取脚本 v2 · 跑在 GitHub Actions 上
// 股票/ETF：东方财富 push2（备用腾讯 GBK）
// 场外基金净值：天天基金 fundgz（自带名称校验，代码配错会被剔除并列入 fund_issues）
// 输出 prices.json：{ updated, source, prices:{代码:{name,price}}, funds:{代码:{name,nav,date}}, fund_issues:[] }

const CODES = [
  ["1", "600036", "招商银行"], ["1", "600887", "伊利股份"], ["1", "600941", "中国移动"],
  ["1", "601919", "中远海控"], ["1", "601985", "中国核电"], ["0", "003816", "中国广核"],
  ["1", "518880", "黄金ETF华安"], ["0", "000538", "云南白药"], ["0", "159841", "证券ETF天弘"],
  ["1", "512480", "半导体ETF"], ["1", "512000", "券商ETF"], ["1", "600938", "中国海油"],
  ["1", "513050", "中概互联"], ["1", "601318", "中国平安"], ["0", "000423", "东阿阿胶"],
  ["1", "600886", "国投电力"], ["1", "516880", "光伏50"], ["1", "601857", "中国石油"],
  ["1", "601728", "中国电信"], ["1", "600011", "华能国际"], ["1", "600795", "国电电力"],
  ["0", "159934", "黄金ETF易方达"], ["1", "512660", "军工ETF"],
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

import { writeFileSync } from "node:fs";

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
  const q = CODES.map(([m, c]) => (m === "1" ? "sh" : "sz") + c).join(",");
  const res = await fetch(`https://qt.gtimg.cn/q=${q}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("tencent http " + res.status);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buf);
  const prices = {};
  for (const line of text.split(";")) {
    const m = line.match(/v_(?:sh|sz)(\d{6})="([^"]+)"/);
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

let result;
try { result = await fromEastmoney(); }
catch (e) { console.error("eastmoney failed:", e.message); result = await fromTencent(); }

const usd = await fetchUsdCny();
if (usd) result.prices["USDT"] = { name: "USDT≈USD/CNH", price: usd };

const funds = {}, fund_issues = [];
for (const [code, expect] of FUNDS) {
  if (!code) { fund_issues.push(`待补代码: ${expect}`); continue; }
  try {
    const f = await fetchFundNav(code);
    if (f.name != null) {
      const a = norm(f.name), b = norm(expect);
      if (!(a.includes(b.slice(0, 4)) || b.includes(a.slice(0, 4)))) {
        fund_issues.push(`名称不匹配: ${code} 预期「${expect}」实际「${f.name}」`);
        continue;
      }
    }
    funds[code] = { name: expect, api_name: f.name || "(f10无名称校验)", nav: f.nav, date: f.date };
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    fund_issues.push(`抓取失败: ${code} ${expect} (${e.message})`);
  }
}

const missing = CODES.filter(([, c]) => !result.prices[c]).map(([, c, n]) => `${c} ${n}`);
if (missing.length) console.warn("stock missing:", missing.join(", "));
if (fund_issues.length) console.warn("fund issues:\n" + fund_issues.join("\n"));

writeFileSync("prices.json", JSON.stringify({
  updated: new Date().toISOString(),
  source: result.source,
  prices: result.prices,
  funds,
  fund_issues,
}, null, 2));
console.log(`ok: ${Object.keys(result.prices).length} stocks, ${Object.keys(funds).length} funds, ${fund_issues.length} issues`);
