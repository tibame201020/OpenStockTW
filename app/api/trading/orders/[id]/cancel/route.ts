import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/better-auth/auth';
import { getBroker } from '@/lib/trading/broker';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    try {
        const order = await getBroker().cancelOrder(session.user.id, id);
        return NextResponse.json({ order });
    } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : 'Cancel failed' }, { status: 400 });
    }
}
