'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { formatPrice } from '@/lib/utils';
import type { Order } from '@/lib/trading/types';

const STATUS_LABEL: Record<string, string> = {
    pending: '掛單中',
    filled: '已成交',
    cancelled: '已取消',
    rejected: '已拒絕',
};

export default function OrdersTable({ initialOrders }: { initialOrders: Order[] }) {
    const [orders, setOrders] = useState(initialOrders);
    const [cancelling, setCancelling] = useState<string | null>(null);

    const cancel = async (id: string) => {
        setCancelling(id);
        try {
            const res = await fetch(`/api/trading/orders/${id}/cancel`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) {
                toast.error('取消失敗', { description: data.error ?? '' });
                return;
            }
            setOrders((os) => os.map((o) => (o.id === id ? data.order : o)));
            toast.success('委託已取消');
        } catch {
            toast.error('取消失敗');
        } finally {
            setCancelling(null);
        }
    };

    if (!orders.length) {
        return <p className="empty-state py-8 text-[13px] text-faint">尚無委託紀錄。去個股頁下第一筆模擬單吧。</p>;
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
                <thead>
                    <tr className="border-b border-line text-left text-faint">
                        <th className="px-3 py-2 font-medium">時間</th>
                        <th className="px-3 py-2 font-medium">股票</th>
                        <th className="px-3 py-2 font-medium">方向</th>
                        <th className="px-3 py-2 text-right font-medium">股數</th>
                        <th className="px-3 py-2 text-right font-medium">類型</th>
                        <th className="px-3 py-2 text-right font-medium">成交價</th>
                        <th className="px-3 py-2 text-right font-medium">手續費/稅</th>
                        <th className="px-3 py-2 text-right font-medium">狀態</th>
                        <th className="px-3 py-2" />
                    </tr>
                </thead>
                <tbody>
                    {orders.map((o) => (
                        <tr key={o.id} className="border-b border-line/60 last:border-0">
                            <td className="px-3 py-2.5 text-faint">
                                {new Date(o.createdAt).toLocaleString('zh-TW', { hour12: false })}
                            </td>
                            <td className="px-3 py-2.5">
                                <Link href={`/stocks/${o.symbol}`} className="mono hover:underline">
                                    {o.symbol}
                                </Link>
                            </td>
                            <td className={`px-3 py-2.5 font-semibold ${o.side === 'buy' ? 'text-red-500' : 'text-green-500'}`}>
                                {o.side === 'buy' ? '買進' : '賣出'}
                            </td>
                            <td className="mono px-3 py-2.5 text-right">{o.qty.toLocaleString()}</td>
                            <td className="px-3 py-2.5 text-right text-faint">
                                {o.orderType === 'market' ? '市價' : `限價 ${o.limitPrice}`}
                            </td>
                            <td className="mono px-3 py-2.5 text-right">
                                {o.fillPrice ? formatPrice(o.fillPrice, 'TWD') : '—'}
                            </td>
                            <td className="mono px-3 py-2.5 text-right text-faint">
                                {o.fee ? `${formatPrice(o.fee, 'TWD')}${o.tax ? ` / ${formatPrice(o.tax, 'TWD')}` : ''}` : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                                <span className="pill h-6 px-2 text-[11.5px]">{STATUS_LABEL[o.status] ?? o.status}</span>
                                {o.status === 'rejected' && o.rejectReason && (
                                    <span className="mt-1 block text-[11px] text-faint">{o.rejectReason}</span>
                                )}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                                {o.status === 'pending' && (
                                    <button
                                        type="button"
                                        onClick={() => cancel(o.id)}
                                        disabled={cancelling === o.id}
                                        className="btn btn-ghost h-7 px-2.5 text-[12px]"
                                    >
                                        {cancelling === o.id && <Loader2 className="size-3.5 animate-spin" />}
                                        取消
                                    </button>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export const pnlClass = (v: number) => (v > 0 ? 'text-red-500' : v < 0 ? 'text-green-500' : 'text-faint');
// TW convention: gains red, losses green (matches the candle chart).
export const signedTwd = (v: number) => `${v > 0 ? '+' : ''}${formatPrice(v, 'TWD')}`;
