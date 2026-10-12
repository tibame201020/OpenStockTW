'use client';

import { useEffect, useRef, useState } from 'react';
import {
    createChart,
    CandlestickSeries,
    HistogramSeries,
    ColorType,
    type IChartApi,
    type ISeriesApi,
} from 'lightweight-charts';
import TradingViewWidget from '@/components/TradingViewWidget';
import { CANDLE_CHART_WIDGET_CONFIG } from '@/lib/constants';

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };

const RANGES = [
    { id: '3m', label: '3M' },
    { id: '6m', label: '6M' },
    { id: '1y', label: '1Y' },
] as const;

// TWSE/TPEX candle charts are not licensable in TradingView embeds, so we draw
// our own with lightweight-charts (MIT) from /api/tw/candles. If our endpoint
// fails (e.g. TPEx blocking the server IP), fall back to the TradingView widget.
export default function TWCandleChart({ symbol, tvSymbol }: { symbol: string; tvSymbol: string }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const [range, setRange] = useState<(typeof RANGES)[number]['id']>('6m');
    const [status, setStatus] = useState<'loading' | 'ready' | 'fallback' | 'error'>('loading');
    const [meta, setMeta] = useState('');

    // Create the chart once.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const chart = createChart(el, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: '#adaba3',
                fontSize: 11,
            },
            grid: {
                vertLines: { color: 'rgba(240, 243, 250, 0.06)' },
                horzLines: { color: 'rgba(240, 243, 250, 0.06)' },
            },
            rightPriceScale: { borderVisible: false },
            timeScale: { borderVisible: false, timeVisible: false },
            crosshair: {
                vertLine: { color: 'rgba(71, 217, 187, 0.4)', labelBackgroundColor: '#47d9bb' },
                horzLine: { color: 'rgba(71, 217, 187, 0.4)', labelBackgroundColor: '#47d9bb' },
            },
            height: 520,
        });
        const candles = chart.addSeries(CandlestickSeries, {
            upColor: '#e5484d',
            downColor: '#30a46c',
            wickUpColor: '#e5484d',
            wickDownColor: '#30a46c',
            borderVisible: false,
        });
        // TW convention: red = up, green = down.
        const volume = chart.addSeries(HistogramSeries, {
            priceScaleId: 'vol',
            priceFormat: { type: 'volume' },
        });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        chartRef.current = chart;
        candleRef.current = candles;
        volumeRef.current = volume;

        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width;
            if (w) chart.applyOptions({ width: w });
        });
        ro.observe(el);
        return () => {
            ro.disconnect();
            chart.remove();
            chartRef.current = null;
        };
    }, []);

    // Load candles per range.
    useEffect(() => {
        let cancelled = false;
        setStatus('loading');
        fetch(`/api/tw/candles?symbol=${encodeURIComponent(symbol)}&range=${range}`)
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then((data: { candles: Candle[] }) => {
                if (cancelled) return;
                const rows = (data.candles ?? []).map((c) => ({
                    time: c.time, // 'YYYY-MM-DD' daily business-day string
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                }));
                const vols = (data.candles ?? []).map((c) => ({
                    time: c.time,
                    value: c.volume,
                    color: c.close >= c.open ? 'rgba(229, 72, 77, 0.5)' : 'rgba(48, 164, 108, 0.5)',
                }));
                candleRef.current?.setData(rows as never);
                volumeRef.current?.setData(vols as never);
                chartRef.current?.timeScale().fitContent();
                setMeta(`${data.candles.length} 個交易日 · 台股日線`);
                setStatus('ready');
            })
            .catch(() => {
                if (!cancelled) setStatus('fallback');
            });
        return () => {
            cancelled = true;
        };
    }, [symbol, range]);

    if (status === 'fallback' || status === 'error') {
        // Our candle endpoint failed (TPEx sometimes blocks server IPs); TradingView
        // embeds do allow TPEX charts, so degrade to the widget instead of an error.
        return (
            <TradingViewWidget
                scriptUrl="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"
                config={CANDLE_CHART_WIDGET_CONFIG(tvSymbol)}
                height={560}
            />
        );
    }

    return (
        <div>
            <div className="mb-2 flex items-center justify-between">
                <div className="flex gap-1">
                    {RANGES.map((r) => (
                        <button
                            key={r.id}
                            type="button"
                            onClick={() => setRange(r.id)}
                            className={`pill h-7 px-2.5 text-[12px] ${range === r.id ? 'is-active' : ''}`}
                        >
                            {r.label}
                        </button>
                    ))}
                </div>
                <span className="text-[12px] text-faint">{status === 'loading' ? '載入中…' : meta}</span>
            </div>
            <div ref={containerRef} className="w-full" style={{ minHeight: 520 }} />
        </div>
    );
}
