import { ethers } from 'ethers';
import { formatTimeDiff } from './orderUtils.js';
import { getDisplaySymbol } from './tokenDisplay.js';

export async function buildOrderRowContext({
    order,
    ws,
    pricing,
    tokenDisplaySymbolMap
}) {
    const sellTokenInfo = await ws.getTokenInfo(order.sellToken);
    const buyTokenInfo = await ws.getTokenInfo(order.buyToken);
    const sellDisplaySymbol = getDisplaySymbol(sellTokenInfo, tokenDisplaySymbolMap);
    const buyDisplaySymbol = getDisplaySymbol(buyTokenInfo, tokenDisplaySymbolMap);

    const {
        formattedSellAmount,
        formattedBuyAmount,
        sellTokenUsdPrice,
        buyTokenUsdPrice
    } = order.dealMetrics || {};

    const safeFormattedSellAmount = typeof formattedSellAmount !== 'undefined'
        ? formattedSellAmount
        : (order?.sellAmount && sellTokenInfo?.decimals != null
            ? ethers.utils.formatUnits(order.sellAmount, sellTokenInfo.decimals)
            : '0');
    const safeFormattedBuyAmount = typeof formattedBuyAmount !== 'undefined'
        ? formattedBuyAmount
        : (order?.buyAmount && buyTokenInfo?.decimals != null
            ? ethers.utils.formatUnits(order.buyAmount, buyTokenInfo.decimals)
            : '0');

    const resolvedSellPrice = typeof sellTokenUsdPrice !== 'undefined'
        ? sellTokenUsdPrice
        : (pricing ? pricing.getPrice(order.sellToken) : undefined);
    const resolvedBuyPrice = typeof buyTokenUsdPrice !== 'undefined'
        ? buyTokenUsdPrice
        : (pricing ? pricing.getPrice(order.buyToken) : undefined);

    const sellPriceClass = (pricing && pricing.isPriceEstimated(order.sellToken)) ? 'price-estimate' : '';
    const buyPriceClass = (pricing && pricing.isPriceEstimated(order.buyToken)) ? 'price-estimate' : '';

    const orderStatus = ws.getOrderStatus(order);
    const expiryEpoch = order?.timings?.expiresAt;
    const currentTime = ws.getCurrentTimestamp();
    const expiryText = orderStatus === 'Active' && typeof expiryEpoch === 'number'
        && Number.isFinite(currentTime)
        ? formatTimeDiff(expiryEpoch - currentTime)
        : '';

    return {
        sellTokenInfo,
        buyTokenInfo,
        sellDisplaySymbol,
        buyDisplaySymbol,
        formattedSellAmount: safeFormattedSellAmount,
        formattedBuyAmount: safeFormattedBuyAmount,
        resolvedSellPrice,
        resolvedBuyPrice,
        sellPriceClass,
        buyPriceClass,
        orderStatus,
        expiryText,
        buyerDealRatio: order.dealMetrics?.deal > 0 ? 1 / order.dealMetrics?.deal : undefined
    };
}
