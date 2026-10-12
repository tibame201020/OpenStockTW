import { Schema, model, models, type Document, type Model } from 'mongoose';

export interface ITradingPosition extends Document {
    userId: string;
    symbol: string;
    qty: number;
    avgCost: number;
}

const TradingPositionSchema = new Schema<ITradingPosition>(
    {
        userId: { type: String, required: true, index: true },
        symbol: { type: String, required: true, uppercase: true, trim: true },
        qty: { type: Number, required: true, min: 0 },
        avgCost: { type: Number, required: true, min: 0 },
    },
    { timestamps: false }
);

TradingPositionSchema.index({ userId: 1, symbol: 1 }, { unique: true });

export const TradingPosition: Model<ITradingPosition> =
    (models?.TradingPosition as Model<ITradingPosition>) ||
    model<ITradingPosition>('TradingPosition', TradingPositionSchema);
