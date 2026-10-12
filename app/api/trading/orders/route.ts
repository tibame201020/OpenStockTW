import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/better-auth/auth';
import { getBroker } from '@/lib/trading/broker';
import { parseTwSymbol } from '@/lib/tw/symbols';
import type { OrderSide, OrderType } from '@/lib/trading/types';

export async function GET() {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const orders = await getBroker().getOrders(session.user.id);
    return NextResponse.json({ orders });
}

export async function POST(req: NextRequest) {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body: { symbol?: string; side?: OrderSide; qty?: number; orderType?: OrderType; limitPrice?: number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const symbol = (body.symbol ?? '').toUpperCase();
    if (!parseTwSymbol(symbol)) {
        return NextResponse.json({ error: 'Symbol must be a TW stock, e.g. TWSE:2330' }, { status: 400 });
    }
    if (body.side !== 'buy' && body.side !== 'sell') {
        return NextResponse.json({ error: 'side must be buy or sell' }, { status: 400 });
    }
    if (body.orderType !== 'market' && body.orderType !== 'limit') {
        return NextResponse.json({ error: 'orderType must be market or limit' }, { status: 400 });
    }

    try {
        const order = await getBroker().placeOrder(session.user.id, {
            symbol,
            side: body.side,
            qty: Number(body.qty),
            orderType: body.orderType,
            limitPrice: body.limitPrice !== undefined ? Number(body.limitPrice) : undefined,
        });
        return NextResponse.json({ order }, { status: order.status === 'rejected' ? 422 : 201 });
    } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : 'Order failed' }, { status: 500 });
    }
}
