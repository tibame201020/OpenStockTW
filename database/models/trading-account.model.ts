import { Schema, model, models, type Document, type Model } from 'mongoose';
import { STARTING_CASH_TWD } from '@/lib/trading/types';

export interface ITradingAccount extends Document {
    userId: string;
    cashTWD: number;
}

const TradingAccountSchema = new Schema<ITradingAccount>(
    {
        userId: { type: String, required: true, unique: true, index: true },
        cashTWD: { type: Number, required: true, default: STARTING_CASH_TWD },
    },
    { timestamps: true }
);

export const TradingAccount: Model<ITradingAccount> =
    (models?.TradingAccount as Model<ITradingAccount>) ||
    model<ITradingAccount>('TradingAccount', TradingAccountSchema);
