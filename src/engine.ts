import { OrderBook } from './order-book.js';
import { Account, checkRisk } from './risk.js';
import { Analytics, BookOrder, Fill, MarketEvent, SandboxOrder, Side } from './types.js';

export class MarketEngine {
  readonly books = new Map<string, OrderBook>();
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly orders: SandboxOrder[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();
  private readonly seenSequences = new Set<string>();
  private orderSequence = 0;

  constructor() { this.seed(); }
  book(symbol: string): OrderBook { let book = this.books.get(symbol); if (!book) { book = new OrderBook(symbol); this.books.set(symbol, book); } return book; }
  ingest(event: MarketEvent): { accepted: boolean; anomaly?: Record<string, unknown> } {
    const key = `${event.symbol}:${event.sequence}`;
    if (this.seenSequences.has(key)) return { accepted: false, anomaly: this.recordAnomaly('duplicate_sequence', event, 'medium') };
    const previous = this.events.filter(item => item.symbol === event.symbol).at(-1);
    if (previous && event.sequence > previous.sequence + 1) this.recordAnomaly('sequence_gap', event, 'high');
    if (previous && event.timestamp < previous.timestamp) this.recordAnomaly('out_of_order_timestamp', event, 'medium');
    this.seenSequences.add(key); this.events.push(event); this.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence); this.book(event.symbol).apply(event);
    return { accepted: true };
  }
  analytics(symbol: string): Analytics {
    const snapshot = this.book(symbol).snapshot(10); const bestBid = snapshot.bids[0]?.price ?? null; const bestAsk = snapshot.asks[0]?.price ?? null; const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null; const bidDepth = snapshot.bids.reduce((sum, l) => sum + l.quantity, 0); const askDepth = snapshot.asks.reduce((sum, l) => sum + l.quantity, 0); const impact = (side: Side, requested: number) => { const levels = side === 'buy' ? snapshot.asks : snapshot.bids; let left = requested, notional = 0, filled = 0; for (const level of levels) { const take = Math.min(left, level.quantity); notional += take * level.price; filled += take; left -= take; if (!left) break; } const averagePrice = filled ? notional / filled : null; const reference = side === 'buy' ? bestAsk : bestBid; return { quantity: requested, averagePrice: averagePrice ? +averagePrice.toFixed(4) : null, slippageBps: averagePrice && reference ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2) : null, filled: +filled.toFixed(4) }; }; const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0; const weightedImbalance = snapshot.bids.length && snapshot.asks.length ? (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) - snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) / (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) + snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) : 0; const spread = bestBid && bestAsk ? bestAsk - bestBid : null; return { symbol, timestamp: snapshot.timestamp, bestBid, bestAsk, midPrice: mid, spread, relativeSpread: mid && spread ? spread / mid : null, bidDepth, askDepth, imbalance: +imbalance.toFixed(4), weightedImbalance: +weightedImbalance.toFixed(4), marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)), marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)), estimatedFillProbability: { buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3), sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3) }, liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2) };
  }
  submitOrder(input: { strategyId: string; symbol: string; side: Side; orderType: 'limit' | 'market'; price?: number; quantity: number }): { accepted: boolean; risk: ReturnType<typeof checkRisk>; fills: Fill[]; orderId: string } {
    const analytics = this.analytics(input.symbol);
    const account = this.account(input.strategyId);
    const price = input.price ?? (input.side === 'buy' ? analytics.bestAsk ?? 0 : analytics.bestBid ?? 0);
    const now = Date.now();
    const risk = checkRisk({ ...input, price, bestBid: analytics.bestBid, bestAsk: analytics.bestAsk, account, now });
    const orderId = `SIM-${++this.orderSequence}`;
    const timestamp = new Date().toISOString();
    if (!risk.allowed) {
      this.orders.push({ id: orderId, strategyId: input.strategyId, symbol: input.symbol, side: input.side, orderType: input.orderType, price, quantity: input.quantity, remaining: input.quantity, status: 'rejected', timestamp });
      this.recordAnomaly('risk_rejection', { id: orderId, symbol: input.symbol, timestamp, sequence: 0 }, 'medium', { strategyId: input.strategyId, orderId, rule: risk.rule, code: risk.code });
      return { accepted: false, risk, fills: [], orderId };
    }
    account.ordersInWindow.push(now);
    const order = { id: orderId, side: input.side, price, quantity: input.quantity, remaining: input.quantity, sequence: this.events.length + 1, owner: input.strategyId, type: input.orderType } as BookOrder & { type: 'limit' | 'market' };
    const fills = this.book(input.symbol).execute(order, timestamp);
    this.fills.push(...fills);
    this.applyFills(account, fills);
    const status = order.remaining <= 0 ? 'filled' : order.remaining < input.quantity ? 'partially_filled' : 'accepted';
    this.orders.push({ id: orderId, strategyId: input.strategyId, symbol: input.symbol, side: input.side, orderType: input.orderType, price, quantity: input.quantity, remaining: order.remaining, status, timestamp });
    if (order.remaining > 0 && input.orderType === 'market') {
      this.recordAnomaly('unfilled_market_order', { id: orderId, symbol: input.symbol, timestamp, sequence: 0 }, 'high', { strategyId: input.strategyId, orderId, remaining: order.remaining });
    }
    return { accepted: true, risk, fills, orderId };
  }
  cancel(strategyId: string, orderId: string): boolean {
    const order = this.orders.find(item => item.id === orderId);
    if (!order || order.strategyId !== strategyId || order.remaining <= 0) return false;
    const book = this.books.get(order.symbol);
    if (!book || !book.cancel(orderId)) return false;
    order.status = 'cancelled';
    order.remaining = 0;
    this.account(strategyId).cancelInWindow.push(Date.now());
    return true;
  }
  strategyEvents(strategyId: string): { orders: SandboxOrder[]; fills: Fill[]; anomalies: Array<Record<string, unknown>> } {
    return {
      orders: this.orders.filter(order => order.strategyId === strategyId),
      fills: this.fills.filter(fill => fill.strategyId === strategyId),
      anomalies: this.anomalies.filter(item => (item.detail as { strategyId?: string } | undefined)?.strategyId === strategyId),
    };
  }
  account(strategyId: string): Account { let account = this.accounts.get(strategyId); if (!account) { account = { strategyId, cash: 1_000_000, equity: 1_000_000, position: {}, ordersInWindow: [], cancelInWindow: [], peakEquity: 1_000_000, maxDrawdown: .15 }; this.accounts.set(strategyId, account); } return account; }
  performance(strategyId: string) { const account = this.account(strategyId); const fills = this.fills.filter(fill => fill.orderId.startsWith('SIM-')); const byStrategy = fills.filter(fill => fill.strategyId === strategyId); const gross = byStrategy.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0); return { strategyId, account, metrics: { fillCount: byStrategy.length, tradedNotional: +byStrategy.reduce((s, f) => s + f.price * f.quantity, 0).toFixed(2), grossCashFlow: +gross.toFixed(2), fees: +byStrategy.reduce((s, f) => s + f.fee, 0).toFixed(2), netPnl: +(gross - byStrategy.reduce((s, f) => s + f.fee, 0)).toFixed(2), exposure: Object.entries(account.position).map(([symbol, quantity]) => ({ symbol, quantity })) } }; }
  private applyFills(account: Account, fills: Fill[]): void { for (const fill of fills) { const delta = fill.side === 'buy' ? fill.quantity : -fill.quantity; account.position[fill.symbol] = (account.position[fill.symbol] ?? 0) + delta; account.cash += fill.side === 'buy' ? -(fill.price * fill.quantity + fill.fee) : fill.price * fill.quantity - fill.fee; } account.equity = account.cash; account.peakEquity = Math.max(account.peakEquity, account.equity); }
  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) { const anomaly = { id: `AN-${this.anomalies.length + 1}`, type, severity, symbol: event.symbol, timestamp: event.timestamp ?? new Date().toISOString(), sequence: event.sequence, detail }; this.anomalies.push(anomaly); return anomaly; }
  private seed(): void { const symbol = 'ALPHA'; const now = new Date('2026-09-30T09:30:00.000Z'); const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, i) => ({ price, quantity: [420, 380, 610, 240, 720][i] })); const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, i) => ({ price, quantity: [300, 490, 260, 580, 410][i] })); this.ingest({ id: 'E-1', symbol, tradingDay: '2026-09-30', timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks }); for (let i = 0; i < 12; i++) this.ingest({ id: `E-${i + 2}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(now.getTime() + (i + 1) * 1000).toISOString(), sequence: i + 2, type: i % 3 === 0 ? 'trade' : 'new_order', orderId: `M-${i + 2}`, side: i % 2 ? 'buy' : 'sell', aggressorSide: i % 2 ? 'buy' : 'sell', price: i % 2 ? 100.01 : 99.99, quantity: 40 + i * 12 }); }
}
