import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:6190';

let server: ChildProcess;

test.before(async () => {
  server = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['src/server.ts'], { cwd: root, stdio: 'ignore' });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      // server still starting
    }
    if (Date.now() > deadline) throw new Error('sandbox server did not start in time');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
});

test.after(() => { server?.kill(); });

async function post(route: string, body: unknown): Promise<any> {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const get = async (route: string): Promise<any> => (await fetch(`${base}${route}`)).json();

test('两个策略交易同一品种：成交/拒单/撤单按 strategyId 隔离', async () => {
  // 双方交错在 ALPHA 上产生成交（市价买入吃卖盘），顺序：S1 -> S2 -> S1
  const s1Buy = await post('/api/sandbox/orders', { strategyId: 'S1', symbol: 'ALPHA', side: 'buy', orderType: 'market', quantity: 100 });
  const s2Buy = await post('/api/sandbox/orders', { strategyId: 'S2', symbol: 'ALPHA', side: 'buy', orderType: 'market', quantity: 80 });
  const s1Buy2 = await post('/api/sandbox/orders', { strategyId: 'S1', symbol: 'ALPHA', side: 'buy', orderType: 'market', quantity: 60 });
  for (const res of [s1Buy, s2Buy, s1Buy2]) assert.equal(res.accepted, true);
  assert.ok(s1Buy.fills.length >= 1 && s2Buy.fills.length >= 1 && s1Buy2.fills.length >= 1);
  const s1FillIds = [...s1Buy.fills, ...s1Buy2.fills].map((f: any) => f.orderId);
  const s2FillIds = s2Buy.fills.map((f: any) => f.orderId);
  assert.ok(s1FillIds.length >= 2 && s2FillIds.length >= 1);
  assert.ok([...s1FillIds, ...s2FillIds].every(id => id && !s1FillIds.some(x => s2FillIds.includes(x))), '双方成交订单号不得重叠');

  // 双方各挂一张休息的限价单，随后用于撤单
  const s1Rest = await post('/api/sandbox/orders', { strategyId: 'S1', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price: 99.9, quantity: 50 });
  const s2Rest = await post('/api/sandbox/orders', { strategyId: 'S2', symbol: 'ALPHA', side: 'buy', orderType: 'limit', price: 99.9, quantity: 30 });
  assert.equal(s1Rest.accepted, true);
  assert.equal(s2Rest.accepted, true);

  // 交叉撤单：任何一方都不能撤对方的单
  const s1CancelsS2 = await post('/api/sandbox/cancel', { strategyId: 'S1', orderId: s2Rest.orderId });
  const s2CancelsS1 = await post('/api/sandbox/cancel', { strategyId: 'S2', orderId: s1Rest.orderId });
  assert.deepEqual(s1CancelsS2, { cancelled: false });
  assert.deepEqual(s2CancelsS1, { cancelled: false });

  // 各自撤自己的单成功
  assert.deepEqual(await post('/api/sandbox/cancel', { strategyId: 'S1', orderId: s1Rest.orderId }), { cancelled: true });
  assert.deepEqual(await post('/api/sandbox/cancel', { strategyId: 'S2', orderId: s2Rest.orderId }), { cancelled: true });

  // 双方各产生一笔拒单：S1 无持仓卖出 -> 金额规则；S2 持仓 80 股，卖 200 股 -> 持仓不足
  const s1Reject = await post('/api/sandbox/orders', { strategyId: 'S1', symbol: 'ALPHA', side: 'sell', orderType: 'market', quantity: 500 });
  const s2Reject = await post('/api/sandbox/orders', { strategyId: 'S2', symbol: 'ALPHA', side: 'sell', orderType: 'market', quantity: 200 });
  assert.equal(s1Reject.accepted, false);
  assert.equal(s2Reject.accepted, false);

  const s1 = await get('/api/sandbox/strategies/S1/events');
  const s2 = await get('/api/sandbox/strategies/S2/events');

  // --- 成交隔离：只看到自己的成交 ---
  assert.ok(s1.fills.every((f: any) => f.strategyId === 'S1'), 'S1 成交必须属于 S1');
  assert.ok(s2.fills.every((f: any) => f.strategyId === 'S2'), 'S2 成交必须属于 S2');
  assert.deepEqual(s1.fills.map((f: any) => f.orderId), s1FillIds, 'S1 视图成交与下单响应一致且顺序保持');
  assert.deepEqual(s2.fills.map((f: any) => f.orderId), s2FillIds);
  assert.ok(!s1.fills.some((f: any) => s2FillIds.includes(f.orderId)), 'S1 不得看到 S2 的成交');
  assert.ok(!s2.fills.some((f: any) => f.orderId === s1Buy.orderId || f.orderId === s1Buy2.orderId), 'S2 不得看到 S1 的成交');

  // --- 成交字段兼容 ---
  for (const fill of [...s1.fills, ...s2.fills]) {
    for (const key of ['orderId', 'symbol', 'side', 'price', 'quantity', 'timestamp', 'liquidity', 'fee', 'strategyId']) {
      assert.ok(key in fill, `成交缺少字段 ${key}`);
    }
    assert.equal(fill.symbol, 'ALPHA');
  }

  // --- 订单隔离与状态 ---
  assert.ok(s1.orders.every((o: any) => o.strategyId === 'S1'));
  assert.ok(s2.orders.every((o: any) => o.strategyId === 'S2'));
  assert.deepEqual(s1.orders.map((o: any) => o.orderId).sort(), [s1Buy.orderId, s1Buy2.orderId, s1Rest.orderId, s1Reject.orderId].sort());
  assert.deepEqual(s2.orders.map((o: any) => o.orderId).sort(), [s2Buy.orderId, s2Rest.orderId, s2Reject.orderId].sort());
  assert.equal(s1.orders.find((o: any) => o.orderId === s1Rest.orderId).status, 'cancelled');
  assert.equal(s2.orders.find((o: any) => o.orderId === s2Rest.orderId).status, 'cancelled');
  assert.equal(s1.orders.find((o: any) => o.orderId === s1Reject.orderId).status, 'rejected');
  assert.equal(s2.orders.find((o: any) => o.orderId === s2Reject.orderId).status, 'rejected');
  assert.equal(s1.orders.find((o: any) => o.orderId === s1Buy.orderId).status, 'filled');
  assert.equal(s1.orders.find((o: any) => o.orderId === s1Buy2.orderId).status, 'filled');
  assert.equal(s2.orders.find((o: any) => o.orderId === s2Buy.orderId).status, 'filled');

  // 订单字段兼容
  for (const order of [...s1.orders, ...s2.orders]) {
    for (const key of ['orderId', 'strategyId', 'symbol', 'side', 'orderType', 'price', 'quantity', 'filledQuantity', 'remaining', 'status', 'timestamp']) {
      assert.ok(key in order, `订单缺少字段 ${key}`);
    }
  }

  // --- 异常隔离：只看到自己的拒单 ---
  assert.ok(s1.anomalies.every((a: any) => a.detail?.strategyId === 'S1'));
  assert.ok(s2.anomalies.every((a: any) => a.detail?.strategyId === 'S2'));
  assert.equal(s1.anomalies.length, 1);
  assert.equal(s2.anomalies.length, 1);
  assert.equal(s1.anomalies[0].type, 'risk_rejection');
  assert.equal(s2.anomalies[0].type, 'risk_rejection');
  assert.equal(s1.anomalies[0].detail.code, 'ORDER_NOTIONAL_LIMIT');
  assert.equal(s2.anomalies[0].detail.code, 'INSUFFICIENT_POSITION');

  // 市场级异常（sequence_gap 等，无 strategyId）不得泄漏到任何策略视图
  const all = await get('/api/anomalies');
  for (const marketAnomaly of all.filter((a: any) => !a.detail?.strategyId)) {
    assert.ok(!s1.anomalies.some((a: any) => a.id === marketAnomaly.id));
    assert.ok(!s2.anomalies.some((a: any) => a.id === marketAnomaly.id));
  }
});

test('未活动过的策略返回空结果', async () => {
  const events = await get('/api/sandbox/strategies/NOBODY/events');
  assert.deepEqual(events, { orders: [], anomalies: [], fills: [] });
});
