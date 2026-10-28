#!/usr/bin/env node
// 把 Omnichat「推播紀錄」的每月推播則數、營業額寫進 KPI（Firestore marketing_kpi/main）
// Omnichat 營業額是推播後 30 天內的歸因、每小時更新 → 每月初更新「上個月」，並把「上上個月」補成最終值
//
//   node broadcast.mjs '{"2026-09":{"count":8,"revenue":115937}}'          寫入
//   node broadcast.mjs '{"2026-09":{"count":8,"revenue":115937}}' --dry-run 只顯示會改什麼
//
// 環境變數：FIREBASE_SERVICE_ACCOUNT（服務帳戶金鑰 JSON 全文）

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const input = JSON.parse(argv.find(a => a.trim().startsWith('{')) || '{}');

const { initializeApp, cert } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('缺少 FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const ref = getFirestore().doc('marketing_kpi/main');
const main = (await ref.get()).data() || {};
const year = String(main.year || '');

const patch = {};
for (const [ym, v] of Object.entries(input)) {
  const [y, m] = ym.split('-');
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m)) throw new Error(`月份格式要像 2026-09：${ym}`);
  const field = y === year ? 'monthlyData' : y === String(+year - 1) ? 'monthlyLastYearData' : null;
  if (!field) { console.log(`跳過 ${ym}：網頁結算年份是 ${year}，只收 ${year} 和 ${+year - 1}`); continue; }
  const count = Math.round(Number(v.count)), revenue = Math.round(Number(v.revenue));
  if (!(count >= 0) || !(revenue >= 0)) throw new Error(`${ym} 數字不對：${JSON.stringify(v)}`);
  const before = main[field]?.[m] || {};
  console.log(`${ym}：推播則數 ${before.broadcastCount ?? 0} → ${count}，推播營收 ${(before.broadcastRevenue ?? 0).toLocaleString()} → ${revenue.toLocaleString()}`);
  patch[`${field}.${m}.broadcastCount`] = count;
  patch[`${field}.${m}.broadcastRevenue`] = revenue;
}
if (!Object.keys(patch).length) { console.log('沒有要更新的月份'); process.exit(0); }
if (DRY) { console.log('--dry-run：不寫入'); process.exit(0); }
patch.updatedAt = new Date().toISOString();
await ref.update(patch);   // 只改推播兩欄，其他欄位（營收、會員、手動資料）不動
console.log('已寫入 marketing_kpi/main');
