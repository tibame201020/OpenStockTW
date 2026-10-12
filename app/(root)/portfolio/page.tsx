import Link from 'next/link';
import Panel from '@/components/Panel';
import OrdersTable, { pnlClass, signedTwd } from '@/components/trading/OrdersTable';
import { getSession } from '@/lib/better-auth/auth';
import { getBroker } from '@/lib/trading/broker';
import { getCompanyProfile } from '@/lib/actions/tw.actions';
import { formatPrice } from '@/lib/utils';

export default async function PortfolioPage() {
    const session = await getSession();
    const userId = session!.user.id;
    const broker = getBroker();
    const [account, positions, orders] = await Promise.all([
        broker.getAccount(userId),
        broker.getPositions(userId),
        broker.getOrders(userId),
    ]);
    const names = new Map<string, string>();
    await Promise.all(
        positions.map(async (p) => {
            const profile = await getCompanyProfile(p.symbol).catch(() => null);
            names.set(p.symbol, profile?.name ?? p.symbol);
        })
    );

    const stats = [
        { label: '現金', value: formatPrice(account.cashTWD, 'TWD') },
        { label: '股票市值', value: formatPrice(account.marketValueTWD, 'TWD') },
        { label: '總資產', value: formatPrice(account.totalValueTWD, 'TWD') },
        {
            label: '未實現損益',
            value: signedTwd(account.unrealizedPnlTWD),
            className: pnlClass(account.unrealizedPnlTWD),
        },
    ];

    return (
        <>
            <header className="page-head">
                <div>
                    <h1 className="page-title">Portfolio</h1>
                    <p className="page-sub">模擬交易 · 起始虛擬資金 NT$1,000,000</p>
                </div>
            </header>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {stats.map((s) => (
                    <Panel key={s.label} bodyClassName="p-4">
                        <p className="text-[12.5px] text-faint">{s.label}</p>
                        <p className={`mono mt-1 text-xl font-bold ${s.className ?? ''}`}>{s.value}</p>
                    </Panel>
                ))}
            </div>

            <Panel title="部位" sub={`${positions.length} 檔持有`}>
                {positions.length === 0 ? (
                    <p className="empty-state py-8 text-[13px] text-faint">目前沒有部位。去個股頁下第一筆模擬單吧。</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-[13px]">
                            <thead>
                                <tr className="border-b border-line text-left text-faint">
                                    <th className="px-3 py-2 font-medium">股票</th>
                                    <th className="px-3 py-2 text-right font-medium">股數</th>
                                    <th className="px-3 py-2 text-right font-medium">平均成本</th>
                                    <th className="px-3 py-2 text-right font-medium">現價</th>
                                    <th className="px-3 py-2 text-right font-medium">市值</th>
                                    <th className="px-3 py-2 text-right font-medium">未實現損益</th>
                                </tr>
                            </thead>
                            <tbody>
                                {positions.map((p) => (
                                    <tr key={p.symbol} className="border-b border-line/60 last:border-0">
                                        <td className="px-3 py-2.5">
                                            <Link href={`/stocks/${p.symbol}`} className="hover:underline">
                                                <span className="font-medium">{names.get(p.symbol)}</span>{' '}
                                                <span className="mono text-[12px] text-faint">{p.symbol}</span>
                                            </Link>
                                        </td>
                                        <td className="mono px-3 py-2.5 text-right">{p.qty.toLocaleString()}</td>
                                        <td className="mono px-3 py-2.5 text-right">{formatPrice(p.avgCost, 'TWD')}</td>
                                        <td className="mono px-3 py-2.5 text-right">
                                            {p.currentPrice ? formatPrice(p.currentPrice, 'TWD') : '—'}
                                        </td>
                                        <td className="mono px-3 py-2.5 text-right">{formatPrice(p.marketValueTWD, 'TWD')}</td>
                                        <td className={`mono px-3 py-2.5 text-right font-medium ${pnlClass(p.unrealizedPnlTWD)}`}>
                                            {signedTwd(p.unrealizedPnlTWD)}
                                            {p.unrealizedPnlPct !== undefined && (
                                                <span className="ml-1 text-[11.5px]">
                                                    ({p.unrealizedPnlPct > 0 ? '+' : ''}{p.unrealizedPnlPct.toFixed(2)}%)
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Panel>

            <Panel title="委託紀錄" sub="含已成交、掛單中、已取消與被拒絕">
                <OrdersTable initialOrders={orders} />
            </Panel>

            <p className="text-[12px] leading-relaxed text-faint">
                手續費 0.1425%（最低 NT$20，買賣皆收）・賣出另收證交稅 0.3%・報價為延遲約 20 分鐘・整數股撮合（實單為一張 1000 股）。
                之後接真實券商只需在 lib/trading/broker.ts 實作 FubonBroker 替換 MockBroker。
            </p>
        </>
    );
}
