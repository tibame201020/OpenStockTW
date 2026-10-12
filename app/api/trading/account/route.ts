import { NextResponse } from 'next/server';
import { getSession } from '@/lib/better-auth/auth';
import { getBroker } from '@/lib/trading/broker';

export async function GET() {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const summary = await getBroker().getAccount(session.user.id);
    return NextResponse.json(summary);
}
