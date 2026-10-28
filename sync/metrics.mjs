// KPI 指標計算（純函式，不連網）
// Shopline 訂單＋顧客 → 每月「官網營收／新增會員／總顧客／舊客」
// 時間一律換成台灣時間（UTC+8）再分月，跟 Shopline 後台報表一致

export const TPE_OFFSET_MS = 8 * 3600 * 1000;
export const pad2 = n => String(n).padStart(2, '0');

/** ISO 時間 → 台灣時間的 [年, 月(兩位數)] */
export function tpeYearMonth(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return null;
  const d = new Date(t + TPE_OFFSET_MS);
  return [String(d.getUTCFullYear()), pad2(d.getUTCMonth() + 1)];
}

/** 台灣時間某年某月 1 日 00:00 的 UTC 毫秒 */
export function tpeMonthStart(year, month) {
  return Date.UTC(+year, +month - 1, 1) - TPE_OFFSET_MS;
}

/* 口徑設定：2026-10-27 用 Shopline API 跟 2025 全年＋2026 上半年手動月報逐月比對後定案
   營收平均差 0.8%、會員 0.2%、總顧客 0%（2025 全年 12 個月完全相同）、舊客 4.5%
   舊客：Shopline 報表的「舊客」是跟「報表起始日」比；以前多半匯出「1/1 到當月」的報表，所以用當年 1/1 當基準 */
export const DEFAULT_DEFINITION = {
  excludeCreatedBy: ['pos'],        // 只算官網：排除實體店 POS 訂單
  excludeStatus: ['cancelled'],     // OnlineTotalSales「總營業額」已扣除取消
  amount: 'total',                  // total＝訂單總額；另有 subtotal、total_minus_delivery 可比對
  customersIncludeCancelled: true,  // OnlineTotalShoppers「總顧客」含取消訂單的顧客（比對後完全吻合）
  returningAnchor: 'year',          // 舊客基準：'year'＝當年 1/1 以前買過；'month'＝當月 1 日以前買過
  priorExcludeCreatedBy: [],        // 判斷舊客時，「之前的訂單」哪些通路不算（預設：全通路都算）
  priorExcludeStatus: [],           // 之前的訂單含取消也算買過（比對後較接近）
  useOrderCountFallback: true,      // API 只抓得到近兩年訂單 → 顧客累計訂單數比抓到的多，就代表更早買過
  memberDateField: 'registered_at', // 新增會員用註冊時間分月
  requireIsMember: true,
};

const money = o => (o && typeof o.dollars === 'number') ? o.dollars
  : (o && typeof o.cents === 'number') ? o.cents / 100 : 0;

export function orderAmount(order, mode) {
  if (mode === 'subtotal') return money(order.subtotal);
  if (mode === 'total_minus_delivery') return money(order.total) - money(order.order_delivery?.total);
  return money(order.total);
}

/** 同一位顧客的識別：有 customer_id 用 id，訪客結帳用 email／電話 */
export const buyerKey = o => o.customer_id
  || (o.customer_email ? 'e:' + String(o.customer_email).trim().toLowerCase() : '')
  || (o.customer_phone ? 'p:' + String(o.customer_phone).replace(/\D/g, '') : '');

/**
 * @param orders     Shopline Get Orders 的 items（抓取範圍內全部，含取消、含 POS）
 * @param customers  Shopline Get Customers 的 items
 * @param years      要輸出的年份，例如 ['2025','2026']
 * @param through    'YYYY-MM'：只輸出到這個月（含），之後的月份不寫
 * @returns { '2026': { '01': {revenue, members, totalCustomers, returningCustomers}, ... }, ... }
 */
export function computeMonthly({ orders, customers = [], years, through, definition = {} }) {
  const def = { ...DEFAULT_DEFINITION, ...definition };
  const ys = new Set(years.map(String));
  const out = {};
  for (const y of ys) out[y] = {};
  const inRange = (y, m) => ys.has(y) && (!through || `${y}-${m}` <= through);
  const cell = (y, m) => (out[y][m] ??= { revenue: 0, members: 0, totalCustomers: 0, returningCustomers: 0 });

  // 1) 每位顧客最早一筆「算數」的訂單時間，以及 API 抓到的訂單數
  const firstPrior = new Map();
  const seenCount = new Map();
  for (const o of orders) {
    const k = buyerKey(o);
    if (!k) continue;
    seenCount.set(k, (seenCount.get(k) || 0) + 1);
    if (def.priorExcludeStatus.includes(o.status) || def.priorExcludeCreatedBy.includes(o.created_by)) continue;
    const t = Date.parse(o.created_at);
    if (!isFinite(t)) continue;
    if (!firstPrior.has(k) || t < firstPrior.get(k)) firstPrior.set(k, t);
  }
  const custById = new Map(customers.map(c => [c.id, c]));
  const hadOlder = k => def.useOrderCountFallback && custById.has(k)
    && (Number(custById.get(k).order_count) || 0) > (seenCount.get(k) || 0);

  // 2) 官網營收、每月消費顧客
  const buyers = new Map();
  for (const o of orders) {
    if (def.excludeCreatedBy.includes(o.created_by)) continue;
    const ym = tpeYearMonth(o.created_at);
    if (!ym) continue;
    const [y, m] = ym;
    if (!inRange(y, m)) continue;
    const excluded = def.excludeStatus.includes(o.status);
    if (!excluded) cell(y, m).revenue += orderAmount(o, def.amount);
    if (excluded && !def.customersIncludeCancelled) continue;
    const k = buyerKey(o);
    if (!k) continue;
    const key = `${y}-${m}`;
    if (!buyers.has(key)) buyers.set(key, new Set());
    buyers.get(key).add(k);
  }
  // 舊客＝這個月有消費、而且在基準日（當年 1/1 或當月 1 日）以前就買過
  for (const [key, set] of buyers) {
    const [y, m] = key.split('-');
    const start = def.returningAnchor === 'month' ? tpeMonthStart(y, m) : tpeMonthStart(y, 1);
    const c = cell(y, m);
    c.totalCustomers = set.size;
    for (const k of set) if ((firstPrior.get(k) ?? Infinity) < start || hadOlder(k)) c.returningCustomers++;
  }

  // 3) 新增會員
  for (const c of customers) {
    if (def.requireIsMember && c.is_member === false) continue;
    const ym = tpeYearMonth(c[def.memberDateField] || c.created_at);
    if (!ym) continue;
    const [y, m] = ym;
    if (!inRange(y, m)) continue;
    cell(y, m).members++;
  }

  for (const y of Object.keys(out)) for (const m of Object.keys(out[y])) out[y][m].revenue = Math.round(out[y][m].revenue);
  return out;
}

/* 拿 API 算出來的數字跟以前手動匯入的月報逐月比對 */
const FIELDS = ['revenue', 'members', 'totalCustomers', 'returningCustomers'];
export function compareMonths(autoYear = {}, manualYear = {}) {
  const rows = [];
  for (const m of Object.keys(autoYear).sort()) {
    const a = autoYear[m], h = manualYear[m] || {};
    for (const f of FIELDS) {
      const mv = Number(h[f]) || 0, av = Number(a[f]) || 0;
      if (!mv && !av) continue;
      rows.push({ month: m, field: f, manual: mv, auto: av, diff: av - mv, pct: mv ? (av - mv) / mv : null });
    }
  }
  return rows;
}

/** 誤差分數：各欄平均絕對百分比誤差（越小越接近手動月報） */
export function errorScore(rows) {
  const out = {};
  for (const f of FIELDS) {
    const xs = rows.filter(r => r.field === f && r.pct != null).map(r => Math.abs(r.pct));
    out[f] = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  }
  return out;
}
