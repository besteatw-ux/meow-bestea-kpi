#!/usr/bin/env node
// BESTEA KPI 自動同步：Shopline → 計算每月指標 → 寫入 Firestore  marketing_kpi/auto
// 每天由 GitHub Actions 執行（.github/workflows/kpi-sync.yml）
//
//   node sync.mjs              抓資料、計算、寫入雲端
//   node sync.mjs --dry-run    只抓和算，印出結果，不寫入
//   node sync.mjs --compare    跟雲端裡手動匯入的月報逐月比對（換口徑前先跑這個）
//   node sync.mjs --out x.json 結果寫成檔案（測試用，不碰雲端）
//
// 環境變數：SHOPLINE_TOKEN（必要）、SHOPLINE_HANDLE（預設 bestea）、
//           FIREBASE_SERVICE_ACCOUNT（服務帳戶金鑰 JSON 全文，寫入／比對時必要）、SHOPLINE_API_BASE（測試用）

import { writeFileSync } from 'node:fs';
import { createClient } from './shopline.mjs';
import { computeMonthly, compareMonths, errorScore, tpeYearMonth, tpeMonthStart, pad2, DEFAULT_DEFINITION } from './metrics.mjs';

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const optVal = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const DRY = flag('--dry-run'), COMPARE = flag('--compare'), OUT = optVal('--out');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const DOC_MAIN = 'marketing_kpi/main';   // 網頁手動資料（推播報表、設定）
const DOC_AUTO = 'marketing_kpi/auto';   // 這支程式寫的自動資料

/* 口徑：沒有特別設定就用預設；比對後若要換，改這裡 */
const DEFINITION = { ...DEFAULT_DEFINITION };

async function firestore() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('缺少 FIREBASE_SERVICE_ACCOUNT（Firebase 服務帳戶金鑰 JSON）');
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  return getFirestore();
}

async function main() {
  const now = new Date();
  const [Y, M] = tpeYearMonth(now.toISOString());
  // 只寫「已經結束的月份」，跟以前手動匯入月報的口徑一樣（本月至今另外放在 mtd）
  const through = M === '01' ? `${+Y - 1}-12` : `${Y}-${pad2(+M - 1)}`;
  const years = [String(+Y - 1), Y];
  // 往前多抓一年訂單，用來判斷舊客；Shopline 兩年以前的訂單會封存、API 抓不到，由顧客累計訂單數補判
  const fromUtc = new Date(tpeMonthStart(+Y - 2, 1)).toISOString().slice(0, 19).replace('T', ' ');

  const sl = createClient({ token: process.env.SHOPLINE_TOKEN, handle: process.env.SHOPLINE_HANDLE || 'bestea', base: process.env.SHOPLINE_API_BASE || undefined, log });
  log(`抓訂單（${fromUtc} UTC 之後）…`);
  const orders = await sl.orders(fromUtc);
  log(`訂單 ${orders.length} 筆；抓顧客…`);
  const customers = await sl.customers();
  log(`顧客 ${customers.length} 位；計算中…`);

  const yearsData = computeMonthly({ orders, customers, years, through, definition: DEFINITION });
  const mtd = computeMonthly({ orders, customers, years: [Y], definition: DEFINITION })[Y]?.[M] || null;
  const doc = {
    source: 'shopline-openapi',
    version: 1,
    updatedAt: now.toISOString(),
    through,
    years: yearsData,
    mtd: mtd ? { month: `${Y}-${M}`, ...mtd } : null,
    counts: { orders: orders.length, customers: customers.length },
    definition: DEFINITION,
  };

  for (const y of years) {
    const ms = Object.keys(yearsData[y] || {}).sort();
    log(`${y}：${ms.length} 個月` + ms.map(m => `\n   ${m} 月 營收 ${yearsData[y][m].revenue.toLocaleString()}  會員 ${yearsData[y][m].members}  顧客 ${yearsData[y][m].totalCustomers}（舊客 ${yearsData[y][m].returningCustomers}）`).join(''));
  }

  if (OUT) { writeFileSync(OUT, JSON.stringify(doc, null, 2)); log(`已寫入檔案 ${OUT}`); return; }

  if (COMPARE) {
    const db = await firestore();
    const snap = await db.doc(DOC_MAIN).get();
    const main = snap.data() || {};
    const manual = { [Y]: main.year === Y ? main.monthlyData : null, [String(+Y - 1)]: main.year === Y ? main.monthlyLastYearData : null };
    if (main.year && main.year !== Y) log(`注意：網頁結算年份是 ${main.year}，今年是 ${Y}`);
    // 同時試幾種口徑，看哪一種最接近手動月報
    const variants = {
      '預設（總額、排除取消與 POS）': {},
      '用小計（不含運費）': { amount: 'subtotal' },
      '總額扣運費': { amount: 'total_minus_delivery' },
      '含 POS 訂單': { excludeCreatedBy: [] },
      '舊客只看官網訂單': { priorExcludeCreatedBy: ['pos'] },
      '不用累計訂單數補判舊客': { useOrderCountFallback: false },
      '會員用建立時間': { memberDateField: 'created_at' },
    };
    for (const [name, v] of Object.entries(variants)) {
      const data = computeMonthly({ orders, customers, years, through, definition: { ...DEFINITION, ...v } });
      const rows = years.flatMap(y => compareMonths(data[y], manual[y] || {}).map(r => ({ year: y, ...r })));
      const score = errorScore(rows);
      console.log(`\n【${name}】平均誤差：` + Object.entries(score).map(([f, e]) => `${f} ${e == null ? '—' : (e * 100).toFixed(1) + '%'}`).join('、'));
      if (name.startsWith('預設')) for (const r of rows) console.log(`  ${r.year}-${r.month} ${r.field.padEnd(18)} 月報 ${String(r.manual).padStart(9)}  API ${String(r.auto).padStart(9)}  差 ${r.pct == null ? '—' : (r.pct * 100).toFixed(1) + '%'}`);
    }
    return;
  }

  if (DRY) { log('--dry-run：不寫入雲端'); return; }

  const db = await firestore();
  await db.doc(DOC_AUTO).set(doc);
  log(`已寫入 ${DOC_AUTO}（資料到 ${through}）`);
}

main().catch(e => { console.error('同步失敗：', e.message); process.exit(1); });
