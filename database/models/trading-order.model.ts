import { Schema, model, models, type Document, type Model } from 'mongoose';
import type { OrderStatus, OrderSide, OrderType } from '@/lib/trading/types';

export interface ITradingOrder extends Document {
    userId: string;
    symbol: string;
    side: OrderSide;
    qty: number;
    orderType: OrderType;
    limitPrice?: number;
    status: OrderStatus;
    rejectReason?: string;
    fillPrice?: number;
    fee?: number;
    tax?: number;
    filledAt?: Date;
    createdAt: Date;
}

const TradingOrderSchema = new Schema<ITradingOrder>(
    {
        userId: { type: String, required: true, index: true },
        symbol: { type: String, required: true, uppercase: true, trim: true },
        side: { type: String, enum: ['buy', 'sell'], required: true },
        qty: { type: Number, required: true, min: 1 },
        orderType: { type: String, enum: ['market', 'limit'], required: true },
        limitPrice: { type: Number, min: 0 },
        status: {
            type: String,
            enum: ['pending', 'filled', 'cancelled', 'rejected'],
            default: 'pending',
            index: true,
        },
        rejectReason: { type: String },
        fillPrice: { type: Number },
        fee: { type: Number },
        tax: { type: Number },
        filledAt: { type: Date },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

TradingOrderSchema.index({ userId: 1, createdAt: -1 });

export const TradingOrder: Model<ITradingOrder> =
    (models?.TradingOrder as Model<ITradingOrder>) || model<ITradingOrder>('TradingOrder', TradingOrderSchema);
