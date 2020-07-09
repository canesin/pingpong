import { CryptoCurrency, Market } from "@neon-exchange/api-client-typescript"

export const SERVICEURL = 'https://swap-prices.nash.io/candle/'
export const MAXUSDC = 1_000

export interface Config {
    sizeupperlimit: number,
    sizelowerlimit: number,
    mindelay: number,
    maxdelay: number
}

export interface SwapCandle {
    open: number,
    close: number,
    volume: number,
    trades: number,
    exchanges: string[],
    high: number,
    low: number,
    closeTime: Date
}

export interface PriceData {
    candle: SwapCandle
}

export interface Spread {
    bid: number,
    ask: number
}

export interface BotOrderBook {
    bid: Map<string, string>,
    ask: Map<string, string>,
    updateId: number,
    market: string
}

export interface MarketSettings {
    tick: number,
    pricedecimals: number,
    sizedecimals: number,
    aUnit: CryptoCurrency,
    bUnit: CryptoCurrency
}