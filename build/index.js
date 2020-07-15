"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fetch_1 = __importDefault(require("node-fetch"));
const api_client_typescript_1 = require("@neon-exchange/api-client-typescript");
const models_1 = require("./models");
let APIKEY = '../pingpong_sandbox_key.json';
let ENV = api_client_typescript_1.EnvironmentConfiguration.sandbox;
let MARKET = process.argv[2].toLowerCase();
switch (process.argv[3]) {
    case 'prod':
        APIKEY = '../pingpong_prod_key.json';
        ENV = api_client_typescript_1.EnvironmentConfiguration.production;
        break;
    default:
        break;
}
const config = require('../config.json')[MARKET.toUpperCase()];
// Create client object which will play ping-pong
const player = new api_client_typescript_1.Client(ENV, {
    enablePerformanceTelemetry: true,
    performanceTelemetryTag: "pingpong_" + random(1, 100000000000).toString() //Give a "unique" ID
});
// Zero buy-no-sell counter (used to detect if we are on a market dive)
// we are creating this variable here at top level just so that we can use inside helper functions
let buyNoSellCounter = 0;
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function random(min, max) {
    return Math.random() * (max - min) + min;
}
async function getassetprice() {
    try {
        const response = await node_fetch_1.default(models_1.SERVICEURL + MARKET.toUpperCase());
        const data = await (response === null || response === void 0 ? void 0 : response.json());
        if (data) {
            // Non-sense tight spread made from candle
            const askprice = Math.max(data.candle.open, data.candle.close);
            const bidprice = Math.min(data.candle.open, data.candle.close);
            return { bid: bidprice, ask: askprice };
        }
        else {
            throw Error('[Error!] computing gold spread');
        }
    }
    catch (error) {
        throw Error('[Error!] fetchting external gold price');
    }
}
async function getInitialOrderBook(client) {
    const initialOrderbookData = await client.getOrderBook(MARKET);
    const askOrderBook = new Map();
    const bidOrderBook = new Map();
    const asks = initialOrderbookData.asks;
    const bids = initialOrderbookData.bids;
    asks.forEach(ask => askOrderBook.set(ask.price.amount, ask.amount.amount));
    bids.forEach(bid => bidOrderBook.set(bid.price.amount, bid.amount.amount));
    return {
        ask: askOrderBook,
        bid: bidOrderBook,
        market: MARKET,
        updateId: initialOrderbookData.updateId
    };
}
function updateBotOrderBook(currentOB, obUpdate) {
    if (currentOB.updateId != obUpdate.lastUpdateId) {
        throw Error('[Error!] Last orderbook update ID is different than current view');
    }
    obUpdate.asks.forEach(ask => {
        if (parseFloat(ask.amount.amount) === 0.0) {
            if (currentOB.ask.has(ask.price.amount)) {
                currentOB.ask.delete(ask.price.amount);
            }
        }
        else {
            currentOB.ask.set(ask.price.amount, ask.amount.amount);
        }
    });
    obUpdate.bids.forEach(bid => {
        if (parseFloat(bid.amount.amount) === 0.0) {
            if (currentOB.bid.has(bid.price.amount)) {
                currentOB.bid.delete(bid.price.amount);
            }
        }
        else {
            currentOB.bid.set(bid.price.amount, bid.amount.amount);
        }
    });
    currentOB.updateId = obUpdate.updateId;
    return currentOB;
}
function edgeTrade(trades, mkt) {
    trades.forEach(trade => {
        if (trade.direction === 'BUY') {
            //!TODO add here the complex call for the logic that extimates the proper sell price
            // this implementation just adds the market tick, making 1 tick profit.
            const sellprice = (parseFloat(trade.limitPrice.amount) + mkt.tick).toFixed(mkt.pricedecimals);
            console.log('[INFO]: placing-sell to edge buy made');
            player.placeLimitOrder(false, trade.amount, api_client_typescript_1.OrderBuyOrSell.SELL, api_client_typescript_1.OrderCancellationPolicy.GOOD_TIL_CANCELLED, api_client_typescript_1.createCurrencyPrice(sellprice, mkt.bUnit, mkt.aUnit), MARKET).then((placedorder) => {
                // Normally placing the order can fail because market moved and the sell would match
                // making it a taker and losing money, but since allowTaker = false it fails.
                // We will than place an order at buy price P + ticker + 0,25% (max taker fee) and let it
                // be taker if needed, this will seat in the books.
                if (placedorder.status == api_client_typescript_1.OrderStatus.CANCELLED) {
                    player.placeLimitOrder(false, trade.amount, api_client_typescript_1.OrderBuyOrSell.SELL, api_client_typescript_1.OrderCancellationPolicy.GOOD_TIL_CANCELLED, api_client_typescript_1.createCurrencyPrice((parseFloat(sellprice) * 1.0025 + mkt.tick).toFixed(mkt.pricedecimals), mkt.bUnit, mkt.aUnit), MARKET);
                }
            });
        }
        else {
            --buyNoSellCounter;
        }
    });
}
function computebuyprice(spread, ob, mkt) {
    let bidstip = -Infinity;
    for (const price of ob.bid.keys()) {
        bidstip = (bidstip < parseFloat(price)) ? parseFloat(price) : bidstip;
    }
    let askstip = +Infinity;
    for (const price of ob.ask.keys()) {
        askstip = (askstip > parseFloat(price)) ? parseFloat(price) : askstip;
    }
    const almostbid = bidstip + mkt.tick < askstip ? bidstip + mkt.tick : bidstip;
    // Global best buy offer, Nash + Market, always improve the world ;)
    // This will make sure prices are in line with global markets and at orderbook tip
    let buyprice = spread.bid.toFixed(mkt.pricedecimals);
    if (isFinite(almostbid)) {
        buyprice = (spread.bid > askstip ? almostbid : Math.max(almostbid, spread.bid)).toFixed(mkt.pricedecimals);
    }
    return buyprice;
}
async function cancelAllBuys() {
    return player.listAccountOrders({
        marketName: MARKET,
        buyOrSell: api_client_typescript_1.OrderBuyOrSell.BUY,
        status: [api_client_typescript_1.OrderStatus.OPEN]
    }).then((buyorders) => {
        buyorders.orders.forEach((order, indes) => {
            player.cancelOrder(order.id, MARKET);
        });
    });
}
function configureConnection(connection, orderbook, mkt) {
    // Set function to update orderbook view
    connection.onUpdatedOrderbook({ marketName: MARKET }, {
        onResult: order => {
            try {
                currentOB = updateBotOrderBook(orderbook, order);
            }
            catch (error) {
                getInitialOrderBook(player).then(res => currentOB = res);
            }
        }
    });
    // Set function to monitor trades
    connection.onAccountTrade({ marketName: MARKET }, {
        onResult: trade => {
            edgeTrade(trade.data.newAccountTrades, mkt);
        }
    });
}
let currentOB;
const run = async () => {
    // Login and get current balances
    await player.login(require(APIKEY));
    const mkt = (await player.listMarkets()).find((market, index) => {
        return market.name == MARKET;
    });
    // Compute market settings to configure prices and sizes for orders
    const mktsettings = {
        tick: parseFloat(mkt.minTickSize),
        pricedecimals: Math.abs(Math.round(Math.log10(parseFloat(mkt.minTickSize)))),
        sizedecimals: Math.abs(Math.round(Math.log10(parseFloat(mkt.minTradeIncrement)))),
        aUnit: mkt.aUnit,
        bUnit: mkt.bUnit
    };
    // First cancel all buy orders in the market on initialization
    await cancelAllBuys();
    // Initially set to disconnected to force it to connect on first iteration
    let isDisconnected = true;
    let buyprice;
    // Play ping-pong! =)
    for (let iteration = 0; iteration < +Infinity; iteration++) {
        // Give some time if market is going down so we don't lock all the funds in future sells
        // time to wait is 15 sec * (2 ^ number of sells without buys)
        if (buyNoSellCounter > 1) {
            console.log('[INFO]: market seens to not be buying, giving more time to match sells');
            let timeToWait = 15000 * (Math.pow(2, buyNoSellCounter));
            console.log(`[INFO]: will wait for ${(timeToWait / 60000).toFixed()}min`);
            await cancelAllBuys();
            await delay(timeToWait);
            --buyNoSellCounter;
        }
        // Check if we are connected, if not try to reconnect
        // After the big delay from dip detection above because delays can cause disconnections
        if (isDisconnected) {
            console.log('[WARNING]: disconnection detected, reconnecting to Nash');
            // Create connection and setup event monitor functions
            const connection = player.createSocketConnection();
            isDisconnected = false;
            // Set function to detect disconnections
            connection.socket.onClose(() => { isDisconnected = true; });
            // Await to see if connection is stablished if not log error and skip to next iter
            await delay(300);
            if (isDisconnected) {
                console.log('[ERROR] Could not connect to Nash exchange! Re-trying in 30 seconds');
                await delay(30000);
                continue;
            }
            currentOB = await getInitialOrderBook(player);
            configureConnection(connection, currentOB, mktsettings);
        }
        if (buyNoSellCounter < 1) {
            // Compute a leading price that is consistent with global markets, present here to devs our
            // endpoint with real-time global markets data =)
            let spread = await getassetprice();
            // Place buy order at  best price and random size
            buyprice = computebuyprice(spread, currentOB, mktsettings);
            // Do a random size just for LOLz - one can compute ideal size from imbalance
            // this size here is just for template, reminder: need to give training on trading for community
            let buysize = random(config.sizelowerlimit, config.sizeupperlimit).toFixed(mktsettings.sizedecimals);
            console.log('[INFO]: placing buy order at price: ', buyprice);
            const placedorder = await player.placeLimitOrder(false, api_client_typescript_1.createCurrencyAmount(buysize, mkt.aUnit), api_client_typescript_1.OrderBuyOrSell.BUY, api_client_typescript_1.OrderCancellationPolicy.GOOD_TIL_CANCELLED, api_client_typescript_1.createCurrencyPrice(buyprice, mkt.bUnit, mkt.aUnit), MARKET);
            // Increment buy-no-sell counter so we can detect the market taking dives
            // this is a simple strategy to not keep buying as the market goes down
            // one can (maybe should?) get a lot more fancy - but this works 80/20
            ++buyNoSellCounter;
        }
        // Check if is price tip, if it is not cancel current buy
        let bidstip = -Infinity;
        for (const price of currentOB.bid.keys()) {
            bidstip = (bidstip < parseFloat(price)) ? parseFloat(price) : bidstip;
        }
        if (isFinite(bidstip) && parseFloat(buyprice) < bidstip) {
            console.log('[WARNING]: Not tip anymore, canceling current buy');
            await cancelAllBuys();
            --buyNoSellCounter;
        }
        // Give some time for market to fill order
        await delay(random(config.mindelay, config.maxdelay) * 1000);
    }
};
run();
//# sourceMappingURL=index.js.map