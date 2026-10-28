// 執行：cd sync && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthly, tpeYearMonth, compareMonths, errorScore } from '../metrics.mjs';

const $ = d => ({ dollars: d });
const order = (id, created_at, total, extra = {}) => ({ id, created_at, status: 'confirmed', created_by: 'shop', customer_id: 'c1', total: $(total), subtotal: $(total - 60), order_delivery: { total: $(60) }, ...extra });

test('台灣時間分月：1/31 23:30（UTC 15:30）算 1 月；2/1 00:30（UTC 1/31 16:30）算 2 月', () => {
  assert.deepEqual(tpeYearMonth('2026-01-31T15:30:00Z'), ['2026', '01']);
  assert.deepEqual(tpeYearMonth('2026-01-31T16:30:00Z'), ['2026', '02']);
  assert.deepEqual(tpeYearMonth('2025-12-31T16:00:00Z'), ['2026', '01']);
});

test('營收：排除取消、排除實體店 POS，其他通路都算', () => {
  const orders = [
    order('a', '2026-01-05T02:00:00Z', 1000),
    order('b', '2026-01-06T02:00:00Z', 500, { status: 'cancelled' }),
    order('c', '2026-01-07T02:00:00Z', 800, { created_by: 'pos' }),
    order('d', '2026-01-08T02:00:00Z', 300, { created_by: 'admin', customer_id: 'c2' }),
    order('e', '2026-01-09T02:00:00Z', 200, { status: 'completed', created_by: 'sc', customer_id: 'c3' }),
  ];
  const r = computeMonthly({ orders, years: ['2026'] });
  assert.equal(r['2026']['01'].revenue, 1500);
  assert.equal(r['2026']['01'].totalCustomers, 3);
});

test('金額口徑可切換：小計、總額扣運費', () => {
  const orders = [order('a', '2026-03-05T02:00:00Z', 1060)];
  assert.equal(computeMonthly({ orders, years: ['2026'], definition: { amount: 'subtotal' } })['2026']['03'].revenue, 1000);
  assert.equal(computeMonthly({ orders, years: ['2026'], definition: { amount: 'total_minus_delivery' } })['2026']['03'].revenue, 1000);
});

const returningOrders = [
  order('a1', '2025-12-20T02:00:00Z', 100, { customer_id: 'old' }),
  order('a2', '2026-01-10T02:00:00Z', 100, { customer_id: 'old' }),
  order('b1', '2026-01-03T02:00:00Z', 100, { customer_id: 'new' }),
  order('b2', '2026-01-25T02:00:00Z', 100, { customer_id: 'new' }),
  order('c1', '2025-11-01T02:00:00Z', 100, { customer_id: 'cx', status: 'cancelled' }),
  order('c2', '2026-01-15T02:00:00Z', 100, { customer_id: 'cx' }),
  order('d1', '2026-01-02T02:00:00Z', 100, { customer_id: 'new2' }),
  order('d2', '2026-02-02T02:00:00Z', 100, { customer_id: 'new2' }),
];

test('舊客（預設＝跟 Shopline 年度報表一樣，以當年 1/1 為基準）：去年買過才算；今年 1 月首購、2 月回購仍算新客；取消的舊訂單也算買過', () => {
  const r = computeMonthly({ orders: returningOrders, years: ['2026'] })['2026'];
  assert.deepEqual([r['01'].totalCustomers, r['01'].returningCustomers], [4, 2], 'old、cx 是舊客');
  assert.deepEqual([r['02'].totalCustomers, r['02'].returningCustomers], [1, 0]);
});

test('舊客改用「當月 1 日」為基準、取消的舊訂單不算：1 月首購、2 月回購 → 2 月是舊客', () => {
  const r = computeMonthly({ orders: returningOrders, years: ['2026'], definition: { returningAnchor: 'month', priorExcludeStatus: ['cancelled'] } })['2026'];
  assert.deepEqual([r['01'].totalCustomers, r['01'].returningCustomers], [4, 1]);
  assert.deepEqual([r['02'].totalCustomers, r['02'].returningCustomers], [1, 1]);
});

test('總顧客含「只下了取消訂單」的顧客，但營收不算取消訂單（跟 OnlineTotalShoppers 一樣）', () => {
  const orders = [
    order('a', '2026-03-05T02:00:00Z', 1000, { customer_id: 'p' }),
    order('b', '2026-03-06T02:00:00Z', 700, { customer_id: 'q', status: 'cancelled' }),
  ];
  const r = computeMonthly({ orders, years: ['2026'] })['2026']['03'];
  assert.deepEqual([r.revenue, r.totalCustomers], [1000, 2]);
  assert.equal(computeMonthly({ orders, years: ['2026'], definition: { customersIncludeCancelled: false } })['2026']['03'].totalCustomers, 1);
});

test('舊客：實體店買過、官網回購也算舊客（預設全通路）；可改成只看官網', () => {
  const orders = [
    order('p', '2025-10-01T02:00:00Z', 100, { customer_id: 'k', created_by: 'pos' }),
    order('o', '2026-01-10T02:00:00Z', 100, { customer_id: 'k' }),
  ];
  assert.equal(computeMonthly({ orders, years: ['2026'] })['2026']['01'].returningCustomers, 1);
  assert.equal(computeMonthly({ orders, years: ['2026'], definition: { priorExcludeCreatedBy: ['pos'] } })['2026']['01'].returningCustomers, 0);
});

test('舊客補判：顧客累計訂單數比抓到的多（更早的訂單已封存）→ 算舊客；關掉補判就不算', () => {
  const orders = [order('a', '2026-01-10T02:00:00Z', 100, { customer_id: 'vip' })];
  const customers = [{ id: 'vip', order_count: 7, is_member: true, registered_at: '2019-01-01T00:00:00Z' }];
  assert.equal(computeMonthly({ orders, customers, years: ['2026'] })['2026']['01'].returningCustomers, 1);
  assert.equal(computeMonthly({ orders, customers, years: ['2026'], definition: { useOrderCountFallback: false } })['2026']['01'].returningCustomers, 0);
});

test('訪客結帳（沒有 customer_id）用 email 認人，大小寫不同算同一人', () => {
  const orders = [
    order('a', '2025-12-03T02:00:00Z', 100, { customer_id: null, customer_email: 'Amy@x.com' }),
    order('b', '2026-02-03T02:00:00Z', 100, { customer_id: null, customer_email: 'amy@x.com ' }),
  ];
  const r = computeMonthly({ orders, years: ['2026'] })['2026'];
  assert.equal(r['02'].returningCustomers, 1);
});

test('新增會員：用註冊時間（台灣時間）分月，非會員不算', () => {
  const customers = [
    { id: '1', is_member: true, registered_at: '2026-01-31T15:59:00Z' },
    { id: '2', is_member: true, registered_at: '2026-01-31T16:01:00Z' },
    { id: '3', is_member: false, registered_at: '2026-01-10T00:00:00Z' },
    { id: '4', is_member: true, registered_at: '2025-12-31T17:00:00Z' },
  ];
  const r = computeMonthly({ orders: [], customers, years: ['2026'] })['2026'];
  assert.equal(r['01'].members, 2);
  assert.equal(r['02'].members, 1);
});

test('through：只輸出到指定月份，本月不會被當成完整月份寫進去', () => {
  const orders = [order('a', '2026-09-10T02:00:00Z', 100), order('b', '2026-10-10T02:00:00Z', 100)];
  const r = computeMonthly({ orders, years: ['2026'], through: '2026-09' })['2026'];
  assert.ok(r['09']);
  assert.equal(r['10'], undefined);
});

test('營收四捨五入成整數（跟月報一樣）', () => {
  const orders = [order('a', '2026-01-05T02:00:00Z', 100.4), order('b', '2026-01-06T02:00:00Z', 100.4, { customer_id: 'z' })];
  assert.equal(computeMonthly({ orders, years: ['2026'] })['2026']['01'].revenue, 201);
});

test('比對工具：算出每欄平均誤差', () => {
  const rows = compareMonths({ '01': { revenue: 110, members: 10, totalCustomers: 5, returningCustomers: 2 } }, { '01': { revenue: 100, members: 10, totalCustomers: 5, returningCustomers: 2 } });
  const s = errorScore(rows);
  assert.ok(Math.abs(s.revenue - 0.1) < 1e-9);
  assert.equal(s.members, 0);
});
