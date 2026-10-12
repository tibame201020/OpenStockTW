'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import Panel from '@/components/Panel';
import { calcFee, calcTax, type OrderSide, type OrderType } from '@/lib/trading/types';
import { formatPrice } from '@/lib/utils';

// Mock order ticket for a TW stock. Posts to /api/trading/orders (session-gated).
// Quantities are integer shares in the mock; real TWSE trading is 1000-share lots.
export default function OrderPanel({ symbol, lastPrice }: { symbol: string; lastPrice?: number }) {
    const [side, setSide] = useState<OrderSide>('buy');
    const [qty, setQty] = useState('100');
    const [orderType, setOrderType] = useState<OrderType>('market');
    const [limitPrice, setLimitPrice] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const qtyNum = Math.floor(Number(qty));
    const refPrice = orderType === 'limit' && Number(limitPrice) > 0 ? Number(limitPrice) : lastPrice;
    const gross = refPrice && qtyNum > 0 ? refPrice * qtyNum : 0;
    const fee = gross > 0 ? calcFee(gross) : 0;
    const tax = side === 'sell' && gross > 0 ? calcTax(gross) : 0;
    const total = side === 'buy' ? gross + fee : gross - fee - tax;

    const submit = async () => {
        if (!qtyNum || qtyNum <= 0) {
            toast.error('請輸入有效股數（正整數）');
            return;
        }
        if (orderType === 'limit' && !(Number(limitPrice) > 0)) {
            toast.error('限價單請輸入限價');
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch('/api/trading/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol,
                    side,
                    qty: qtyNum,
                    orderType,
                    limitPrice: orderType === 'limit' ? Number(limitPrice) : undefined,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                toast.error('下單失敗', { description: data.error ?? '未知錯誤' });
                return;
            }
            const order = data.order;
            if (order.status === 'filled') {
                toast.success(
                    `${side === 'buy' ? '買進' : '賣出'}成交 ${qtyNum} 股 @ ${formatPrice(order.fillPrice, 'TWD')}`,
                    { description: `手續費 ${formatPrice(order.fee, 'TWD')}${order.tax ? `・證交稅 ${formatPrice(order.tax, 'TWD')}` : ''}` }
                );
            } else if (order.status === 'pending') {
                toast.success('限價單已掛出（pending）', { description: '市價到達限價時才會成交（撮合排程尚未實作）' });
            } else {
                toast.error('委託被拒絕', { description: order.rejectReason ?? '' });
            }
        } catch {
            toast.error('下單失敗，請稍後再試');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Panel title="下單" sub="模擬交易 · 整數股（實單為一張 1000 股）">
            <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-hover/60 p-1">
                    {(['buy', 'sell'] as OrderSide[]).map((s) => (
                        <button
                            key={s}
                            type="button"
                            onClick={() => setSide(s)}
                            className={`h-9 rounded-md text-sm font-semibold transition-colors ${
                                side === s
                                    ? s === 'buy'
                                        ? 'bg-red-500 text-white'
                                        : 'bg-green-600 text-white'
                                    : 'text-faint hover:text-foreground'
                            }`}
                        >
                            {s === 'buy' ? '買進' : '賣出'}
                        </button>
                    ))}
                </div>

                <div className="grid grid-cols-2 gap-1 rounded-lg bg-hover/60 p-1">
                    {(['market', 'limit'] as OrderType[]).map((t) => (
                        <button
                            key={t}
                            type="button"
                            onClick={() => setOrderType(t)}
                            className={`h-8 rounded-md text-[13px] font-medium transition-colors ${
                                orderType === t ? 'bg-brand text-on-brand' : 'text-faint hover:text-foreground'
                            }`}
                        >
                            {t === 'market' ? '市價' : '限價'}
                        </button>
                    ))}
                </div>

                <label className="flex flex-col gap-1.5">
                    <span className="text-[12.5px] text-faint">股數</span>
                    <input
                        type="number"
                        min={1}
                        step={1}
                        value={qty}
                        onChange={(e) => setQty(e.target.value)}
                        className="form-input mono"
                        placeholder="100"
                    />
                </label>

                {orderType === 'limit' && (
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[12.5px] text-faint">限價 (TWD)</span>
                        <input
                            type="number"
                            min={0}
                            step={0.05}
                            value={limitPrice}
                            onChange={(e) => setLimitPrice(e.target.value)}
                            className="form-input mono"
                            placeholder={lastPrice ? String(lastPrice) : '0.00'}
                        />
                    </label>
                )}

                <div className="rounded-lg bg-hover/40 p-3 text-[12.5px]">
                    <div className="flex justify-between py-0.5">
                        <span className="text-faint">參考價</span>
                        <span className="mono">{refPrice ? formatPrice(refPrice, 'TWD') : '—'}</span>
                    </div>
                    <div className="flex justify-between py-0.5">
                        <span className="text-faint">預估手續費 (0.1425%, 最低 20)</span>
                        <span className="mono">{gross > 0 ? formatPrice(fee, 'TWD') : '—'}</span>
                    </div>
                    {side === 'sell' && (
                        <div className="flex justify-between py-0.5">
                            <span className="text-faint">預估證交稅 (0.3%)</span>
                            <span className="mono">{gross > 0 ? formatPrice(tax, 'TWD') : '—'}</span>
                        </div>
                    )}
                    <div className="mt-1 flex justify-between border-t border-line pt-1.5 font-semibold">
                        <span>{side === 'buy' ? '預估扣款' : '預估入帳'}</span>
                        <span className="mono">{gross > 0 ? formatPrice(total, 'TWD') : '—'}</span>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={submit}
                    disabled={submitting}
                    style={side === 'buy' ? { background: '#e5484d', color: '#fff' } : { background: '#30a46c', color: '#fff' }}
                    className="btn h-10 w-full text-sm font-semibold hover:opacity-90"
                >
                    {submitting && <Loader2 className="size-4 animate-spin" />}
                    {side === 'buy' ? '買進' : '賣出'} {symbol.replace(/^(TWSE|TPEX):/, '')}
                </button>
                <p className="text-[11.5px] leading-relaxed text-faint">
                    模擬撮合：市價單以最新延遲報價立即成交；限價單達價即成交，否則掛為 pending。
                </p>
            </div>
        </Panel>
    );
}
