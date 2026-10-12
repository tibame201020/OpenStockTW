// Mock trading engine types (lib/trading).
//
// This module is a self-contained paper-trading engine. All money is virtual
// (TWD). To connect a real broker later (e.g. Fubon's TradeAPI), implement
// `BrokerAdapter` in broker.ts (see the MockBroker comments there) — the
// API routes and UI below it don't change.

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';

export interface Order {
    id: string;
    userId: string;
    symbol: string; // e.g. 'TWSE:2330'
    side: OrderSide;
    qty: number; // shares, positive integer
    orderType: OrderType;
    limitPrice?: number; // required when orderType === 'limit'
    status: OrderStatus;
    rejectReason?: string;
    createdAt: Date;
    filledAt?: Date;
    fillPrice?: number; // per-share fill price
    fee?: number; // 手續費 TWD
    tax?: number; // 證交稅 TWD (sell only)
}

export interface Position {
    userId: string;
    symbol: string;
    qty: number; // shares
    avgCost: number; // per-share average cost incl. buy fees
}

export interface Account {
    userId: string;
    cashTWD: number;
}

/** TW fee rules used by the mock (mirror real brokerage): */
export const FEE_RATE = 0.001425; // 手續費 0.1425%
export const FEE_MIN_TWD = 20; // 最低 NT$20
export const TAX_RATE_SELL = 0.003; // 證交稅 0.3% (sell only)
export const STARTING_CASH_TWD = 1_000_000;

export const calcFee = (amount: number) => Math.max(Math.round(amount * FEE_RATE), FEE_MIN_TWD);
export const calcTax = (amount: number) => Math.round(amount * TAX_RATE_SELL);

export interface PlaceOrderInput {
    symbol: string;
    side: OrderSide;
    qty: number;
    orderType: OrderType;
    limitPrice?: number;
}
