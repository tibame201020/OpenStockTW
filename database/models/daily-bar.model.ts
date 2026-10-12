import { Schema, model, models, type Document, type Model } from 'mongoose';

export interface IDailyBar extends Document {
    /** 'TWSE:2330' | 'TPEX:6488' */
    symbol: string;
    /** 'YYYY-MM-DD' (Asia/Taipei trading date) */
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    /** shares */
    volume: number;
    source: 'twse' | 'tpex';
}

const DailyBarSchema = new Schema<IDailyBar>(
    {
        symbol: { type: String, required: true, uppercase: true, trim: true },
        date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        open: { type: Number, required: true },
        high: { type: Number, required: true },
        low: { type: Number, required: true },
        close: { type: Number, required: true },
        volume: { type: Number, required: true, default: 0 },
        source: { type: String, enum: ['twse', 'tpex'], required: true },
    },
    { timestamps: true }
);

// One bar per symbol per trading day; backfill uses this for upserts.
DailyBarSchema.index({ symbol: 1, date: 1 }, { unique: true });
// Per-day coverage check ("is 2024-05-06 already backfilled?").
DailyBarSchema.index({ date: 1, source: 1 });

export const DailyBar: Model<IDailyBar> =
    (models?.DailyBar as Model<IDailyBar>) || model<IDailyBar>('DailyBar', DailyBarSchema);
