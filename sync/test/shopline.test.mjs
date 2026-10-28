// 用假的 Shopline 伺服器測：分頁、限速、429 重試、漏抓防呆、整支 sync.mjs 跑到輸出檔案
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../shopline.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function mockServer({ orders, customers, fail429Once = false, lieTotal = false }) {
  let hits = 0, seen429 = false; const auth = [];
  const srv = http.createServer((req, res) => {
    hits++;
    auth.push([req.headers.authorization, req.headers['user-agent']]);
    const u = new URL(req.url, 'http://x');
    if (fail429Once && !seen429) { seen429 = true; res.writeHead(429); return res.end('{"code":"RateLimitExceeded"}'); }
    const list = u.pathname.endsWith('/orders') ? orders.filter(o => !u.searchParams.get('created_after') || o.created_at >= u.searchParams.get('created_after').replace(' ', 'T') + 'Z') : customers;
    const per = +u.searchParams.get('per_page') || 24, page = +u.searchParams.get('page') || 1;
    const items = list.slice((page - 1) * per, page * per);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items, pagination: { current_page: page, per_page: per, total_pages: Math.max(1, Math.ceil(list.length / per)), total_count: list.length + (lieTotal ? 5 : 0) } }));
  });
  return new Promise(r => srv.listen(0, () => r({ srv, base: `http://127.0.0.1:${srv.address().port}/v1`, hits: () => hits, auth })));
}

const mkOrders = n => Array.from({ length: n }, (_, i) => ({ id: 'o' + i, created_at: new Date(Date.UTC(2026, 0, 1 + (i % 28), 2)).toISOString(), status: 'confirmed', created_by: 'shop', customer_id: 'c' + (i % 40), total: { dollars: 100 } }));

test('分頁抓完 123 筆（50 筆一頁、3 頁），每次都帶金鑰和商店代號', async () => {
  const { srv, base, hits, auth } = await mockServer({ orders: mkOrders(123), customers: [] });
  const sl = createClient({ token: 'TEST', handle: 'bestea', base, rps: 50 });
  const got = await sl.orders('2025-01-01 00:00:00');
  srv.close();
  assert.equal(got.length, 123);
  assert.equal(hits(), 3);
  assert.ok(auth.every(([a, ua]) => a === 'Bearer TEST' && ua === 'bestea'));
});

test('遇到 429 會等一下自動重試', async () => {
  const { srv, base } = await mockServer({ orders: mkOrders(10), customers: [], fail429Once: true });
  const sl = createClient({ token: 'T', base, rps: 50 });
  const got = await sl.orders('2025-01-01 00:00:00');
  srv.close();
  assert.equal(got.length, 10);
});

test('筆數對不上（漏抓）就報錯，不會寫入不完整的資料', async () => {
  const { srv, base } = await mockServer({ orders: mkOrders(10), customers: [], lieTotal: true });
  const sl = createClient({ token: 'T', base, rps: 50 });
  await assert.rejects(() => sl.orders('2025-01-01 00:00:00'), /資料不完整/);
  srv.close();
});

test('沒有金鑰時直接說清楚', () => {
  assert.throws(() => createClient({ token: '' }), /SHOPLINE_TOKEN/);
});

test('整支 sync.mjs：從假 Shopline 抓資料 → 輸出檔案，格式正確', async () => {
  const orders = mkOrders(60), customers = Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i, is_member: true, registered_at: '2026-01-15T02:00:00Z', order_count: 1 }));
  const { srv, base } = await mockServer({ orders, customers });
  const out = join(mkdtempSync(join(tmpdir(), 'kpi-')), 'auto.json');
  await new Promise((res, rej) => execFile(process.execPath, [join(here, '..', 'sync.mjs'), '--out', out], { env: { ...process.env, SHOPLINE_TOKEN: 'T', SHOPLINE_API_BASE: base } }, (e, so, se) => e ? rej(new Error(se || so)) : res()));
  srv.close();
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(doc.source, 'shopline-openapi');
  assert.ok(doc.years['2026']['01'], '有 2026-01');
  assert.equal(doc.years['2026']['01'].revenue, 6000);
  assert.equal(doc.years['2026']['01'].members, 40);
  assert.equal(doc.years['2026']['01'].totalCustomers, 40);
  assert.match(doc.through, /^\d{4}-\d{2}$/);
});
