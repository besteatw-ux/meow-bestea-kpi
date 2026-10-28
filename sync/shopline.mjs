// Shopline OpenAPI 用戶端：分頁（多頁同時抓）、限速（官方上限每秒 20 次，這裡保守用 10 次）、429／5xx 自動重試
// 文件：https://open-api.docs.shoplineapp.com/docs/openapi-request-example

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createClient({ token, handle = 'bestea', base = 'https://open.shopline.io/v1', fetchImpl = fetch, rps = 10, concurrency = 6, log = () => {} }) {
  if (!token) throw new Error('缺少 SHOPLINE_TOKEN（Shopline 後台「管理員設定 > API Auth」產生的金鑰）');
  const gap = 1000 / rps;
  let nextSlot = 0;
  // 每個請求先預約一個時間格，多個請求同時跑也不會超過每秒 rps 次
  const reserve = async () => { const now = Date.now(); const slot = Math.max(now, nextSlot); nextSlot = slot + gap; if (slot > now) await sleep(slot - now); };

  async function get(path, params = {}) {
    const url = new URL(base.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      await reserve();
      let res;
      try {
        res = await fetchImpl(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'User-Agent': handle } });
      } catch (e) {
        if (attempt >= 5) throw new Error(`連不上 Shopline（${path}）：${e.message}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 5) throw new Error(`Shopline 回應 ${res.status}（${path}），重試 5 次仍失敗`);
        log(`Shopline ${res.status}，${2 ** attempt} 秒後重試`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(`Shopline 金鑰無效或沒有權限（${res.status} ${path}）：請確認 API Auth 有勾選「訂單」和「顧客」的讀取權限`);
      if (!res.ok) throw new Error(`Shopline ${res.status} ${path}：${(await res.text()).slice(0, 200)}`);
      return res.json();
    }
  }

  /** 抓完全部分頁：先抓第 1 頁知道總頁數，其餘頁同時抓；用 id 去重，並核對總筆數確保沒漏 */
  async function getAll(path, params = {}, label = path) {
    const per = 50;
    const first = await get(path, { ...params, per_page: per, page: 1 });
    const totalPages = first.pagination?.total_pages || 1;
    const totalCount = first.pagination?.total_count ?? null;
    const pages = new Array(totalPages);
    pages[0] = first.items || [];
    let next = 2, done = 1;
    async function worker() {
      while (next <= totalPages) {
        const p = next++;
        const j = await get(path, { ...params, per_page: per, page: p });
        pages[p - 1] = j.items || [];
        if (++done % 25 === 0) log(`${label}：${done}/${totalPages} 頁`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(0, totalPages - 1)) }, worker));
    const seen = new Set(), items = [];
    for (const pg of pages) for (const it of pg) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    if (totalCount != null && items.length < totalCount) throw new Error(`${label} 只抓到 ${items.length} 筆，Shopline 說有 ${totalCount} 筆，資料不完整，這次不寫入`);
    return items;
  }

  return {
    get,
    /** createdAfterUtc：'YYYY-MM-DD HH:mm:ss'（UTC）；舊的在前，抓取中途有新訂單也不會讓前面的頁位移 */
    orders: createdAfterUtc => getAll('/orders', { created_after: createdAfterUtc, sort_by: 'asc' }, '訂單'),
    customers: () => getAll('/customers', { sort_by: 'asc' }, '顧客'),
  };
}
