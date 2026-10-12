// Broker abstraction + mock implementation.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │ HOW TO CONNECT A REAL BROKER LATER (e.g. Fubon TradeAPI)             │
// │ 1. Create `lib/trading/fubon-broker.ts` with                        │
// │      export class FubonBroker implements BrokerAdapter { ... }       │
// │    (auth via the fubon-tradeapi skill; signing lives in the SDK)     │
// │ 2. In `getBroker()` below, return `new FubonBroker()` instead.      │
// │ 3. Done: API routes (/api/trading/*) and UI call only BrokerAdapter. │
// │ NOTE: real TWSE trading is in lots of 1000 shares; the mock accepts │
// │ any positive integer qty for experimentation and the UI says so.     │
// └─────────────────────────────────────────────────────────────────────┘

import { connectToDatabase } from '@/database/mongoose';
import { TradingAccount } from '@/database/models/trading-account.model';
import { TradingPosition } from '@/database/models/trading-position.model';
import { TradingOrder, type ITradingOrder } from '@/database/models/trading-order.model';
import { getQuote } from '@/lib/actions/tw.actions';
import {
    calcFee,
    calcTax,
    STARTING_CASH_TWD,
    type Account,
    type Order,
    type OrderStatus,
    type PlaceOrderInput,
    type Position,
} from '@/lib/trading/types';

export interface AccountSummary extends Account {
    marketValueTWD: number;
    totalValueTWD: number;
    unrealizedPnlTWD: number;
}

export interface PositionView extends Position {
    currentPrice?: number;
    marketValueTWD: number;
    unrealizedPnlTWD: number;
    unrealizedPnlPct?: number;
}

export interface BrokerAdapter {
    placeOrder(userId: string, input: PlaceOrderInput): Promise<Order>;
    cancelOrder(userId: string, orderId: string): Promise<Order>;
    getOrders(userId: string, limit?: number): Promise<Order[]>;
    getPositions(userId: string): Promise<PositionView[]>;
    getAccount(userId: string): Promise<AccountSummary>;
}

const toOrder = (d: ITradingOrder): Order => ({
    id: String(d._id),
    userId: d.userId,
    symbol: d.symbol,
    side: d.side,
    qty: d.qty,
    orderType: d.orderType,
    limitPrice: d.limitPrice,
    status: d.status,
    rejectReason: d.rejectReason,
    createdAt: d.createdAt,
    filledAt: d.filledAt,
    fillPrice: d.fillPrice,
    fee: d.fee,
    tax: d.tax,
});

async function getOrCreateAccount(userId: string) {
    let acct = await TradingAccount.findOne({ userId });
    if (!acct) {
        acct = await TradingAccount.create({ userId, cashTWD: STARTING_CASH_TWD });
    }
    return acct;
}

async function recordOrder(
    userId: string,
    input: PlaceOrderInput,
    status: OrderStatus,
    extra: Partial<Pick<ITradingOrder, 'rejectReason' | 'fillPrice' | 'fee' | 'tax' | 'filledAt'>> = {}
) {
    const doc = await TradingOrder.create({
        userId,
        symbol: input.symbol.toUpperCase(),
        side: input.side,
        qty: input.qty,
        orderType: input.orderType,
        limitPrice: input.limitPrice,
        status,
        ...extra,
    });
    return toOrder(doc);
}

export class MockBroker implements BrokerAdapter {
    /**
     * Market orders fill immediately at the latest TW quote.
     * Limit orders fill immediately when marketable (buy: limit >= last, sell: limit <= last),
     * otherwise they rest as `pending` (a future matcher cron could fill them; not built yet).
     * Fees follow real TW rules: 0.1425% (min NT$20) both sides + 0.3% securities tax on sells.
     */
    async placeOrder(userId: string, input: PlaceOrderInput): Promise<Order> {
        await connectToDatabase();

        const symbol = (input.symbol || '').toUpperCase();
        const qty = Math.floor(Number(input.qty));
        if (!symbol) return recordOrder(userId, { ...input, symbol: '?' }, 'rejected', { rejectReason: 'Missing symbol' });
        if (!Number.isInteger(qty) || qty <= 0) {
            return recordOrder(userId, { ...input, symbol }, 'rejected', { rejectReason: 'Quantity must be a positive integer' });
        }
        if (input.orderType === 'limit' && !(Number(input.limitPrice) > 0)) {
            return recordOrder(userId, { ...input, symbol }, 'rejected', { rejectReason: 'Limit orders need a limit price' });
        }

        const quote = await getQuote(symbol);
        const last = quote?.c;
        if (!last || !Number.isFinite(last) || last <= 0) {
            return recordOrder(userId, { ...input, symbol, qty }, 'rejected', { rejectReason: 'No live quote for this symbol right now' });
        }

        let fillPrice: number | null = null;
        if (input.orderType === 'market') {
            fillPrice = last;
        } else {
            const limit = Number(input.limitPrice);
            const marketable = input.side === 'buy' ? limit >= last : limit <= last;
            if (marketable) fillPrice = last;
        }

        const cleanInput: PlaceOrderInput = { symbol, side: input.side, qty, orderType: input.orderType, limitPrice: input.limitPrice };

        if (fillPrice === null) {
            // Resting limit order; nothing moves until a matcher fills it.
            return recordOrder(userId, cleanInput, 'pending');
        }

        const gross = fillPrice * qty;
        const fee = calcFee(gross);

        if (input.side === 'buy') {
            const cost = gross + fee;
            const acct = await getOrCreateAccount(userId);
            if (acct.cashTWD < cost) {
                return recordOrder(userId, cleanInput, 'rejected', {
                    rejectReason: `Insufficient cash (need NT$${Math.round(cost).toLocaleString()})`,
                });
            }
            acct.cashTWD -= cost;
            await acct.save();

            const pos = await TradingPosition.findOne({ userId, symbol });
            if (pos) {
                pos.avgCost = (pos.qty * pos.avgCost + gross + fee) / (pos.qty + qty);
                pos.qty += qty;
                await pos.save();
            } else {
                await TradingPosition.create({ userId, symbol, qty, avgCost: (gross + fee) / qty });
            }
            return recordOrder(userId, cleanInput, 'filled', { fillPrice, fee, tax: 0, filledAt: new Date() });
        }

        // sell
        const pos = await TradingPosition.findOne({ userId, symbol });
        if (!pos || pos.qty < qty) {
            return recordOrder(userId, cleanInput, 'rejected', {
                rejectReason: `Insufficient position (holding ${pos?.qty ?? 0} shares)`,
            });
        }
        const tax = calcTax(gross);
        const proceeds = gross - fee - tax;
        const acct = await getOrCreateAccount(userId);
        acct.cashTWD += proceeds;
        await acct.save();
        pos.qty -= qty;
        if (pos.qty === 0) await pos.deleteOne();
        else await pos.save();
        return recordOrder(userId, cleanInput, 'filled', { fillPrice, fee, tax, filledAt: new Date() });
    }

    async cancelOrder(userId: string, orderId: string): Promise<Order> {
        await connectToDatabase();
        const doc = await TradingOrder.findOne({ _id: orderId, userId });
        if (!doc) throw new Error('Order not found');
        if (doc.status !== 'pending') throw new Error(`Only pending orders can be cancelled (status: ${doc.status})`);
        doc.status = 'cancelled';
        await doc.save();
        return toOrder(doc);
    }

    async getOrders(userId: string, limit = 50): Promise<Order[]> {
        await connectToDatabase();
        const docs = await TradingOrder.find({ userId }).sort({ createdAt: -1 }).limit(limit);
        return docs.map(toOrder);
    }

    async getPositions(userId: string): Promise<PositionView[]> {
        await connectToDatabase();
        const docs = await TradingPosition.find({ userId }).sort({ symbol: 1 });
        const views: PositionView[] = [];
        for (const d of docs) {
            const quote = await getQuote(d.symbol);
            const currentPrice = quote?.c;
            const marketValueTWD = currentPrice ? currentPrice * d.qty : d.avgCost * d.qty;
            const unrealizedPnlTWD = marketValueTWD - d.avgCost * d.qty;
            views.push({
                userId: d.userId,
                symbol: d.symbol,
                qty: d.qty,
                avgCost: d.avgCost,
                currentPrice,
                marketValueTWD,
                unrealizedPnlTWD,
                unrealizedPnlPct: d.avgCost > 0 ? (unrealizedPnlTWD / (d.avgCost * d.qty)) * 100 : undefined,
            });
        }
        return views;
    }

    async getAccount(userId: string): Promise<AccountSummary> {
        await connectToDatabase();
        const acct = await getOrCreateAccount(userId);
        const positions = await this.getPositions(userId);
        const marketValueTWD = positions.reduce((s, p) => s + p.marketValueTWD, 0);
        const unrealizedPnlTWD = positions.reduce((s, p) => s + p.unrealizedPnlTWD, 0);
        return {
            userId,
            cashTWD: acct.cashTWD,
            marketValueTWD,
            totalValueTWD: acct.cashTWD + marketValueTWD,
            unrealizedPnlTWD,
        };
    }
}

// Swap this for FubonBroker (real) when ready. Everything above it is UI/API.
export const getBroker = (): BrokerAdapter => new MockBroker();
