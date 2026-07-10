// Homeport 行情抓取脚本 · 跑在 GitHub Actions 上
// 主源：东方财富 push2 批量接口；备用源：腾讯行情（GBK 解码）
// 输出 prices.json：{ updated, source, prices: { 代码: { name, price } } }

const CODES = [
  // [市场前缀 1=沪 0=深, 代码, 名称]
  ["1", "600036", "招商银行"],
  ["1", "600887", "伊利股份"],
  ["1", "600941", "中国移动"],
  ["1", "601919", "中远海控"],
  ["1", "601985", "中国核电"],
  ["0", "003816", "中国广核"],
  ["1", "518880", "黄金ETF华安"],
  ["0", "000538", "云南白药"],
  ["0", "159841", "证券ETF天弘"],
  ["1", "512480", "半导体ETF"],
  ["1", "512000", "券商ETF"],
  ["1", "600938", "中国海油"],
  ["1", "513050", "中概互联"],
  ["1", "601318", "中国平安"],
  ["0", "000423", "东阿阿胶"],
  ["1", "600886", "国投电力"],
  ["1", "516880", "光伏50"],
  ["1", "601857", "中国石油"],
  ["1", "601728", "中国电信"],
  ["1", "600011", "华能国际"],
  ["1", "600795", "国电电力"],
  ["0", "159934", "黄金ETF易方达"],
  ["1", "512660", "军工ETF"],
];

import { writeFileSync } from "node:fs";

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

let result;
try {
  result = await fromEastmoney();
} catch (e) {
  console.error("eastmoney failed:", e.message);
  result = await fromTencent();
}

const missing = CODES.filter(([, c]) => !result.prices[c]).map(([, c, n]) => `${c} ${n}`);
if (missing.length) console.warn("missing:", missing.join(", "));

writeFileSync("prices.json", JSON.stringify({
  updated: new Date().toISOString(),
  source: result.source,
  prices: result.prices,
}, null, 2));
console.log(`ok: ${Object.keys(result.prices).length} prices via ${result.source}`);
