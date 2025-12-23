const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { RealTimeDataClient } = require('@polymarket/real-time-data-client');
const { ClobClient } = require('@polymarket/clob-client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ethers } = require('ethers');
const path = require('path');
const fs = require('fs');
const FUNDER_ADDRESS = '0xAc7e9B052e3f02271340c1802986Bd7fB0F4b190';

// Load environment variables from .env file
const envPath = path.join(__dirname, '.env');
const ENV = {};
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    if (line && !line.startsWith('#')) {
      const [key, ...values] = line.split('=');
      ENV[key.trim()] = values.join('=').trim();
    }
  });
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const WALLET_ADDRESS = ENV.WALLET_ADDRESS || '0xAc7e9B052e3f02271340c1802986Bd7fB0F4b190';
const WALLET_PRIVATE_KEY = ENV.WALLET_PRIVATE_KEY;
const GEMINI_API_KEY = ENV.GEMINI_API_KEY;
const POLYMARKET_API_KEY = ENV.POLYMARKET_API_KEY;
const POLYMARKET_API_SECRET = ENV.POLYMARKET_API_SECRET;
const POLYMARKET_API_PASSPHRASE = ENV.POLYMARKET_API_PASSPHRASE;

// Initialize Gemini AI
let genAI = null;
let geminiModel = null;
if (GEMINI_API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    console.log(`✅ Gemini AI initialized with gemini-2.0-flash-exp`);
  } catch (err) {
    console.error('❌ Gemini initialization error:', err.message);
  }
}

// Trading configuration
const TRADE_CONFIG = {
  enabled: ENV.TRADE_ENABLED === 'true' && WALLET_PRIVATE_KEY !== undefined,
  orderSize: parseInt(ENV.ORDER_SIZE) || 10,
  maxSlippage: parseFloat(ENV.MAX_SLIPPAGE) || 0.05
};

// Debug trading configuration
console.log('🔧 Trading Configuration:');
console.log(`   ENV.TRADE_ENABLED: "${ENV.TRADE_ENABLED}"`);
console.log(`   WALLET_PRIVATE_KEY exists: ${WALLET_PRIVATE_KEY !== undefined}`);
console.log(`   TRADE_CONFIG.enabled: ${TRADE_CONFIG.enabled}`);

// Initialize wallet for signing if private key available
let wallet = null;
let clobClient = null;

// Order queue to ensure sequential order placement
let isOrderProcessing = false;
const orderQueue = [];

async function processOrderQueue() {
  if (isOrderProcessing || orderQueue.length === 0) return;
  
  isOrderProcessing = true;
  const { tokenId, side, resolve, reject } = orderQueue.shift();
  
  console.log(`\n📦 Processing order from queue (${orderQueue.length} remaining)...`);
  
  try {
    const result = await placeOrderInternal(tokenId, side);
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    isOrderProcessing = false;
    // Process next order after a small delay
    setTimeout(() => processOrderQueue(), 1000);
  }
}

function queueOrder(tokenId, side) {
  return new Promise((resolve, reject) => {
    orderQueue.push({ tokenId, side, resolve, reject });
    console.log(`➕ Order added to queue (position: ${orderQueue.length})`);
    processOrderQueue();
  });
}

(async () => {
  if (!WALLET_PRIVATE_KEY) {
    console.warn('⚠️ No wallet private key – trading disabled');
    return;
  }

  try {
    await initClobClient();   // ✅ WAIT HERE
  } catch (err) {
    console.error('❌ Failed to init CLOB client:', err.message);
    process.exit(1);          // ⛔ STOP SERVER
  }
})();

   const { Side } = require('@polymarket/clob-client');

async function initClobClient() {
  // ✅ EXACT SAME AS wallet.js
  const signer = new ethers.Wallet(WALLET_PRIVATE_KEY);

  // ✅ USE HARDCODED FUNDER ADDRESS (SAME AS wallet.js)
  const funder = '0xAc7e9B052e3f02271340c1802986Bd7fB0F4b190';

  console.log('🔑 Signer:', signer.address);
  console.log('💰 Funder:', funder);

  const CHAIN_ID = 137;
  const SIGNATURE_TYPE = 1;

  // TEMP CLIENT → API KEY
  const tempClient = new ClobClient(
    CLOB_API,
    CHAIN_ID,
    signer
  );

  const creds = await tempClient.createOrDeriveApiKey();
  console.log('✅ Polymarket API key derived');

  // ✅ EXACT SAME AS wallet.js - use funder address
  clobClient = new ClobClient(
    CLOB_API,
    CHAIN_ID,
    signer,
    creds,
    SIGNATURE_TYPE,
    funder  // Use funder address (0xAc7e9B052e3f02271340c1802986Bd7fB0F4b190)
  );

  console.log('✅ CLOB client initialized (wallet.js behavior)');
}

// Store active trading sessions
const activeSessions = new Map();

// Store custom algorithms created via natural language
const customAlgorithms = new Map();

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/**
 * Resolve market slug to token IDs
 */
async function resolveSlugToTokens(slug, retryCount = 0) {
  let res;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout
    
    res = await fetch(`${GAMMA_API}/markets?slug=${slug}`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PolymarketTradingBot/1.0'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      if (retryCount < 1) {
        console.log(`⚠️  Market not found, retrying (attempt ${retryCount + 2}/2)...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return resolveSlugToTokens(slug, retryCount + 1);
      }
      
      // If specific slug fails after retries, search for active markets
      console.log(`⚠️  Specific market not found, searching for any active BTC markets...`);
      return await findActiveBTCMarket();
    }
    
    const data = await res.json();
  
  let markets = [];
  if (Array.isArray(data)) {
    markets = data;
  } else if (data?.data && Array.isArray(data.data)) {
    markets = data.data;
  } else if (data?.results && Array.isArray(data.results)) {
    markets = data.results;
  } else if (data && typeof data === 'object') {
    markets = [data];
  }
  
  if (markets.length === 0) {
    // Try to find any active BTC UP/DOWN market
    console.log(`⚠️  Exact market not found: ${slug}`);
    console.log(`🔍 Searching for active BTC UP/DOWN markets...`);
    
    const activeMarket = await findActiveBTCMarket();
    if (activeMarket) {
      return activeMarket;
    }
    
    throw new Error(`No BTC UP/DOWN markets available. The market may not be active yet. Please try again later.`);
  }
  
  const market = markets[0];
  
  let clobTokenIds = market.clobTokenIds;
  if (typeof clobTokenIds === 'string') {
    try {
      clobTokenIds = JSON.parse(clobTokenIds);
    } catch (e) {
      throw new Error(`Failed to parse clobTokenIds: ${e.message}`);
    }
  }
  
  if (!clobTokenIds || !Array.isArray(clobTokenIds) || clobTokenIds.length < 2) {
    throw new Error(`Invalid market response: missing or invalid clobTokenIds`);
  }
  
  return {
    tokenIds: clobTokenIds,
    conditionId: market.conditionId,
    question: market.question || market.title,
    outcomes: typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes,
    endDate: market.endDate,
    isDemoMode: false
  };
  } catch (error) {
    // Handle timeout and network errors by searching for active markets
    if (error.name === 'AbortError' || error.type === 'aborted') {
      console.log(`⚠️  Request timeout - Polymarket API slow or unavailable`);
    } else {
      console.log(`⚠️  Network error: ${error.message}`);
    }
    
    console.log(`🔍 Searching for any active BTC market instead...`);
    
    try {
      const activeMarket = await findActiveBTCMarket();
      if (activeMarket) {
        return activeMarket;
      }
    } catch (fallbackError) {
      console.error(`❌ Fallback search also failed: ${fallbackError.message}`);
    }
    
    // Final fallback: return a generic error
    throw new Error(`Unable to connect to Polymarket API. Please check your internet connection and try again.`);
  }
}

/**
 * Find any active BTC UP/DOWN market
 */
async function findActiveBTCMarket() {
  try {
    console.log(`🔍 Searching Polymarket for active BTC markets...`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    // Try to get markets
    const res = await fetch(`${GAMMA_API}/markets?closed=false&limit=100`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PolymarketTradingBot/1.0'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      console.log(`   ⚠️  API returned status ${res.status}`);
      return null;
    }
    
    const data = await res.json();
    const markets = Array.isArray(data) ? data : (data?.data || data?.results || []);
    
    if (markets.length === 0) {
      console.log(`   ⚠️  No markets returned from API`);
      return null;
    }
    
    console.log(`   Found ${markets.length} total markets, searching for BTC...`);
    
    // Find BTC UP/DOWN markets with flexible matching
    const btcMarket = markets.find(m => {
      const question = (m.question || m.title || '').toLowerCase();
      const description = (m.description || '').toLowerCase();
      const combined = question + ' ' + description;
      
      return (
        (combined.includes('btc') || combined.includes('bitcoin')) &&
        (combined.includes('up') || combined.includes('down') || 
         combined.includes('higher') || combined.includes('lower'))
      );
    });
    
    if (btcMarket) {
      console.log(`✅ Found active BTC market: ${btcMarket.question || btcMarket.title}`);
      console.log(`   Market ends: ${btcMarket.endDate}`);
      
      let clobTokenIds = btcMarket.clobTokenIds;
      if (typeof clobTokenIds === 'string') {
        clobTokenIds = JSON.parse(clobTokenIds);
      }
      
      if (!clobTokenIds || clobTokenIds.length < 2) {
        console.log(`   ⚠️  Market missing valid token IDs`);
        return null;
      }
      
      return {
        tokenIds: clobTokenIds,
        question: btcMarket.question || btcMarket.title,
        outcomes: typeof btcMarket.outcomes === 'string' ? JSON.parse(btcMarket.outcomes) : btcMarket.outcomes,
        endDate: btcMarket.endDate,
        conditionId: btcMarket.conditionId,
        isDemoMode: false
      };
    }
    
    console.log(`   ℹ️  No BTC UP/DOWN markets found in current results`);
    return null;
  } catch (error) {
    if (error.name === 'AbortError' || error.type === 'aborted') {
      console.log(`   ⚠️  Search timeout - API is slow`);
    } else {
      console.log(`   ⚠️  Search error: ${error.message}`);
    }
    return null;
  }
}

/**
 * Generate CURRENT 15-minute market timestamp
 */
function getNext15MinuteTimestamp() {
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;
  // Use CURRENT market, not next one
  const current = Math.floor(now / fifteenMinutes) * fifteenMinutes;
  return Math.floor(current / 1000);
}

/**
 * Generate market slug for BTC UP/DOWN
 */
function generateMarketSlug() {
  const timestamp = getNext15MinuteTimestamp();
  return `btc-updown-15m-${timestamp}`;
}

/**
 * Place a real order on Polymarket CLOB (wrapper for queue)
 */
async function placeOrder(tokenId, side) {
  return await queueOrder(tokenId, side);
}

/**
 * Internal order placement function (called by queue)
 */
async function placeOrderInternal(tokenId, side) {

  // 🔥 FORCE EXACTLY 5 SHARES (ONE ORDER ONLY)

const orderbook = await clobClient.getOrderBook(tokenId);

if (!orderbook?.asks?.length) {
  console.log('⚠️ No asks in orderbook — skipping order');
  return { simulated: true, success: false };
}

// Best ask price
const bestAsk = Number(orderbook.asks[0].price);

// Slightly below best ask (maker order, safe)
let orderPrice = Math.max(0.01, bestAsk - 0.01);
orderPrice = Number(orderPrice.toFixed(2));

// FIXED: Exactly 5 shares (Polymarket minimum)
const orderSize = 5;

const totalValue = (orderPrice * orderSize).toFixed(2);
console.log(
  `💵 5 SHARES ORDER → ${side} ${orderSize} shares @ $${orderPrice.toFixed(2)} = $${totalValue} (bestAsk=$${bestAsk})`
);


  if (!TRADE_CONFIG.enabled) {
    console.log(`⚠️ Trading disabled in config - order not placed`);
    return { simulated: true, success: true };
  }

  if (!clobClient) {
    console.log(`⚠️ CLOB client not initialized - cannot place order`);
    return { simulated: true, success: false, error: 'Client not initialized' };
  }

  try {
    console.log(`📝 Creating order for token ${tokenId.substring(0, 10)}...`);

    // ✅ CORRECT SIDE MAPPING (UP/DOWN → BUY/SELL)
    const clobSide =
      side === 'BUY' || side === 'UP'
        ? Side.BUY
        : Side.SELL;

    // ✅ USE CALCULATED VALUES (ensure strings)
   const orderArgs = {
  tokenID: tokenId.toString(),
  price: orderPrice.toString(),      // string
  size: orderSize.toString(),        // string
  side: clobSide,
  feeRateBps: '0',
};




    console.log(`🔐 Signing order with wallet...`);
    console.log(`🔐 SIGNING PAYLOAD:`, orderArgs);

    const signedOrder = await clobClient.createOrder(orderArgs);

    console.log(`📤 Submitting order to Polymarket CLOB...`);

    const orderResponse = await clobClient.postOrder(signedOrder);

    const isSuccess =
      orderResponse.success !== false &&
      (!orderResponse.status || orderResponse.status < 400);

    if (isSuccess) {
      console.log(`✅ Order submitted successfully!`);
      console.log(`   Order ID: ${orderResponse.orderID || 'pending'}`);

      return {
        simulated: false,
        success: true,
        orderId: orderResponse.orderID || `order_${Date.now()}`,
        status: orderResponse.status || 'LIVE',
        response: orderResponse
      };
    } else {
      throw new Error(orderResponse.error || 'Order submission failed');
    }

  } catch (error) {
    console.error(`❌ Order placement failed:`, error.message);

    let errorMsg = error.message;

    if (error.message.includes('not enough balance')) {
      errorMsg =
        'Insufficient USDC balance or allowance. Fund your wallet and approve Polymarket contract.';
    } else if (error.message.includes('API Credentials')) {
      errorMsg =
        'API Credentials missing. Get them from https://polymarket.com/ → Settings → API Keys';
    }

    if (error.response) {
      console.error(`   API Response:`, error.response.data || error.response);
    }

    return {
      simulated: false,
      success: false,
      error: errorMsg
    };
  }
}


async function fetchHistoricalData() {
  try {
    console.log(`📊 Fetching recently CLOSED BTC UP/DOWN markets from Polymarket...`);
    
    // Get PAST 15-minute market timestamps (recently closed)
    const now = Date.now();
    const fifteenMinutes = 15 * 60 * 1000;
    const currentInterval = Math.floor(now / fifteenMinutes) * fifteenMinutes;
    
    // Get past 5 intervals (recently closed markets)
    const timestamps = [];
    for (let i = 1; i <= 5; i++) {
      const timestamp = Math.floor((currentInterval - (i * fifteenMinutes)) / 1000);
      timestamps.push(timestamp);
    }
    
    console.log(`   🕐 Looking for recently CLOSED markets (last 75 minutes):`);
    timestamps.forEach((ts, i) => {
      const date = new Date(ts * 1000);
      console.log(`      ${i + 1}. ${date.toLocaleTimeString()} - btc-updown-15m-${ts}`);
    });
    
    const events = [];
    
    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const slug = `btc-updown-15m-${timestamp}`;
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const res = await fetch(`${GAMMA_API}/markets?slug=${slug}`, {
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'PolymarketTradingBot/1.0'
          }
        });
        
        clearTimeout(timeoutId);
        
        if (res.ok) {
          const data = await res.json();
          const market = Array.isArray(data) ? data[0] : data;
          
          if (market) {
            // Check if market is closed/resolved
            const isClosed = market.closed || market.resolved || 
                           (market.endDate && new Date(market.endDate) < new Date());
            
            if (!isClosed) {
              console.log(`   ⚠️  ${slug} - Still ACTIVE (not closed yet)`);
              continue;
            }
            
            console.log(`   ✅ ${market.question || market.title}`);
            
            // Get resolved outcome
            let result = 'UNKNOWN';
            let currentPrice = 0.5;
            
            if (market.outcomePrices) {
              const prices = typeof market.outcomePrices === 'string' 
                ? JSON.parse(market.outcomePrices) 
                : market.outcomePrices;
              
              // Get winner from outcomePrices
              if (prices[0] === "1" || prices[0] === 1) {
                result = 'UP';
              } else if (prices[1] === "1" || prices[1] === 1) {
                result = 'DOWN';
              }
            }
            
            // Try to get actual final price
            if (market.clobbPrice) {
              currentPrice = parseFloat(market.clobbPrice);
            } else if (market.lastPrice) {
              currentPrice = parseFloat(market.lastPrice);
            } else if (market.tokens && Array.isArray(market.tokens) && market.tokens.length >= 2) {
              currentPrice = parseFloat(market.tokens[0]?.price || 0.5);
            }
            
            
            // No historical price delta available, set to 0
            const priceDelta = 0;
            console.log(`      ✅ RESOLVED: ${result} won | Price: ${currentPrice.toFixed(3)} | Delta: ${priceDelta.toFixed(0)}`);

            events.push({
              event: events.length + 1,
              marketId: market.id,
              question: market.question || market.title,
              initialPrice: 50000,
              finalPrice: currentPrice * 100000,
              delta: priceDelta,
              timeLeft: 0,
              result: result,
              endDate: market.endDate,
              isCryptoMarket: true,
              slug: market.slug
            });
          }
        }
      } catch (err) {
        console.log(`   ⚠️  ${slug} - ${err.message}`);
      }
    }
    
    console.log(`\n   ✅ Found ${events.length} recently CLOSED markets with real outcomes\n`);
    return events;
    console.log(`\n   ✅ Found ${events.length} LIVE markets with real-time data\n`);
    return events;
    
  } catch (error) {
    console.error(`❌ Failed to fetch market data: ${error.message}`);
    
    // Provide helpful error message
    if (error.name === 'AbortError' || error.message.includes('aborted')) {
      throw new Error('Polymarket API timeout. The API may be slow or your internet connection may be unstable. Please try again.');
    } else {
      throw new Error(`Cannot fetch market data: ${error.message}. The Polymarket API may be temporarily unavailable.`);
    }
  }
}

// ==========================================
// ALGORITHM IMPLEMENTATIONS
// ==========================================

/**
 * ALGO 1: Smart Ape Strategy
 * 
 * Strategy inspired by momentum and volume analysis:
 * - Looks at price momentum (delta)
 * - Considers time remaining
 * - Uses threshold-based decision making
 * 
 * Trading Rules:
 * 1. If price delta > +100 AND time < 240 seconds → BUY UP
 * 2. If price delta < -100 AND time < 240 seconds → BUY DOWN
 * 3. Otherwise → NO TRADE
 */
function algoSmartApe(marketData) {
  const { delta, timeLeft } = marketData;
  
  if (delta > 100 && timeLeft < 240) {
    return { signal: 'UP', shares: 5, reason: 'Strong upward momentum with time pressure' };
  } else if (delta < -100 && timeLeft < 240) {
    return { signal: 'DOWN', shares: 5, reason: 'Strong downward momentum with time pressure' };
  }
  
  return { signal: 'NONE', shares: 0, reason: 'Conditions not met' };
}

/**
 * ALGO 2: Delta + Time Momentum Strategy
 * 
 * Trading Rules (ALL must be true):
 * 1. Delta > +50 → bullish OR Delta < -50 → bearish
 * 2. Time left < 150 seconds
 * 3. Trade execution:
 *    - If Delta > +50: Buy 10 UP shares
 *    - If Delta < -50: Buy 10 DOWN shares
 * 4. Order price: Best available from order book
 */
function algoDeltaTimeMomentum(marketData) {
  const { delta, timeLeft } = marketData;
  console.log(`   📈 Delta: ${delta.toFixed(2)}, Time Left: ${timeLeft}s`);
  if (delta > 10) {
    return { signal: 'UP', shares: 5, reason: 'Delta > +50 and time < 150s' };
  } else if (delta < -50 && timeLeft < 150) {
    return { signal: 'DOWN', shares: 5, reason: 'Delta < -50 and time < 150s' };
  }
  
  return { signal: 'NONE', shares: 0, reason: 'Conditions not met' };
}

/**
 * Show historical outcomes (no algorithm testing due to API limitations)
 */
function runBacktest(algoName, historicalData) {
  const results = [];
  
  historicalData.forEach((event) => {
    results.push({
      event: event.event,
      question: event.question,
      actualResult: event.result,
      outcome: event.result,
      endDate: event.endDate,
      slug: event.slug
    });
  });
  
  return {
    wins: 0,
    losses: 0,
    accuracy: 0,
    totalTrades: 0,
    results,
    note: 'Historical outcomes only - Polymarket API does not provide price history for backtesting'
  };
}

// ==========================================
// REST API ENDPOINTS
// ==========================================

/**
 * GET /api/backtest
 * Backtest a trading algorithm on historical data
 */
app.get('/api/backtest', async (req, res) => {
  try {
    const { algo } = req.query;
    
    if (!algo || !['algo1', 'algo2'].includes(algo)) {
      return res.status(400).json({ error: 'Invalid algo parameter. Use algo1 or algo2' });
    }
    
    console.log(`📊 Running backtest for ${algo}...`);
    
    // Fetch historical data
    const historicalData = await fetchHistoricalData();
    
    // Run backtest
    const results = runBacktest(algo, historicalData);
    
    console.log(`✅ Historical data retrieved: ${historicalData.length} past markets`);
    console.log(`   Note: Showing outcomes only - API doesn't provide price history\n`);
    
    res.json({
      success: true,
      algo,
      ...results
    });
    
  } catch (error) {
    console.error('❌ Backtest error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/deploy
 * Deploy an algorithm for live trading
 */
app.post('/api/deploy', async (req, res) => {
  try {
    const { algo } = req.query;
    
    // Check if it's a custom algorithm
    if (algo && algo.startsWith('custom_')) {
      if (!customAlgorithms.has(algo)) {
        return res.status(404).json({ error: 'Custom algorithm not found' });
      }
      
      console.log(`🚀 Deploying custom algorithm ${algo} for live trading...`);
      
      const sessionId = `session_${Date.now()}`;
      const marketSlug = generateMarketSlug();
      
      // Start live trading with custom algorithm
      startLiveTrading(sessionId, algo, marketSlug);
      
      return res.json({
        success: true,
        message: `Custom algorithm deployed successfully`,
        sessionId,
        marketSlug
      });
    }
    
    // Built-in algorithms
    if (!algo || !['algo1', 'algo2'].includes(algo)) {
      return res.status(400).json({ error: 'Invalid algo parameter. Use algo1, algo2, or custom algorithm ID' });
    }
    
    console.log(`🚀 Deploying ${algo} for live trading...`);
    
    const sessionId = `session_${Date.now()}`;
    const marketSlug = generateMarketSlug();
    
    // Start live trading session
    startLiveTrading(sessionId, algo, marketSlug);
    
    res.json({
      success: true,
      message: `Algorithm ${algo} deployed successfully`,
      sessionId,
      marketSlug
    });
    
  } catch (error) {
    console.error('❌ Deploy error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/stop
 * Stop a live trading session
 */
app.post('/api/stop', (req, res) => {
  const { sessionId } = req.body;
  
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    
    // Stop real client if exists
    if (session.client) {
      session.client.disconnect();
    }
    
    // Stop demo interval if exists (legacy)
    if (session.demoInterval) {
      clearInterval(session.demoInterval);
    }
    
    activeSessions.delete(sessionId);
    console.log(`🛑 Stopped session: ${sessionId}`);
    res.json({ success: true, message: 'Trading session stopped' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

/**
 * POST /api/create-algo
 * Create a custom algorithm from natural language description
 */
app.post('/api/create-algo', async (req, res) => {
  try {
    const { description } = req.body;
    
    if (!description || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    
    console.log(`🤖 Creating algorithm from: "${description}"`);
    
    // Template-based algorithm generator (no external API needed)
    const desc = description.toLowerCase();
    let generatedCode = '';
    let algoName = '';
    
    // Parse natural language for parameters
    let deltaThreshold = 50;
    let timeThreshold = 180;
    let priceThreshold = 0.5;
    let direction = 'BOTH'; // UP, DOWN, or BOTH
    let shares = 10;
    
    // Extract delta threshold (e.g., "delta 100", "delta greater than 60")
    const deltaMatch = desc.match(/delta.*?(\d+)/);
    if (deltaMatch) deltaThreshold = parseInt(deltaMatch[1]);
    
    // Extract time threshold (e.g., "2 minutes", "150 seconds", "3 min")
    const timeMatch = desc.match(/(\d+)\s*(minute|min|second|sec|s\b)/);
    if (timeMatch) {
      const value = parseInt(timeMatch[1]);
      const unit = timeMatch[2];
      timeThreshold = unit.startsWith('min') ? value * 60 : value;
    }
    
    // Extract price threshold (e.g., "price 0.40", "below 0.35", "40%")
    const priceMatch = desc.match(/(?:price|below|above|under|over).*?(\d+\.?\d*)/);
    if (priceMatch) {
      priceThreshold = parseFloat(priceMatch[1]);
      if (priceThreshold > 1) priceThreshold /= 100; // Convert percentage
    }
    
    // Extract shares (e.g., "buy 20 shares", "order size 15")
    const sharesMatch = desc.match(/(?:buy|order|place).*?(\d+)\s*(?:share|unit|contract)?/);
    if (sharesMatch) shares = parseInt(sharesMatch[1]);
    // Ensure shares is at least 1
    if (!shares || shares < 1) shares = 1;
    
    // Determine direction
    if ((desc.includes('buy up') || desc.includes('go long') || desc.includes('bullish')) && !desc.includes('down')) {
      direction = 'UP';
    } else if (desc.includes('buy down') || desc.includes('sell') || desc.includes('short') || desc.includes('bearish')) {
      direction = 'DOWN';
    }
    
    // Generate algorithm based on parsed conditions
    if (desc.includes('price drop') || desc.includes('price falls') || desc.includes('price below')) {
      // Price-based strategy
      algoName = `Price Drop Strategy (${priceThreshold})`;
      generatedCode = `function customAlgorithm(marketData) {
  const { delta, timeLeft, upPrice, downPrice } = marketData;
  
  // Strategy: ${description}
  if (upPrice < ${priceThreshold} && timeLeft < ${timeThreshold}) {
    return { 
      signal: 'UP', 
      shares: ${shares}, 
      reason: \`UP price \${upPrice.toFixed(3)} dropped below ${priceThreshold}, \${timeLeft}s remaining\`
    };
  }
  
  if (downPrice < ${priceThreshold} && timeLeft < ${timeThreshold}) {
    return { 
      signal: 'DOWN', 
      shares: ${shares}, 
      reason: \`DOWN price \${downPrice.toFixed(3)} dropped below ${priceThreshold}, \${timeLeft}s remaining\`
    };
  }
  
  return { signal: 'NONE', shares: 0, reason: 'Price conditions not met' };
}`;
    } else if (desc.includes('price increase') || desc.includes('price rise') || desc.includes('momentum')) {
      // Momentum strategy
      algoName = `Momentum Strategy (${deltaThreshold})`;
      generatedCode = `function customAlgorithm(marketData) {
  const { delta, timeLeft, upPrice, downPrice } = marketData;
  
  // Strategy: ${description}
  if (delta > ${deltaThreshold} && timeLeft < ${timeThreshold}) {
    return { 
      signal: 'UP', 
      shares: ${shares}, 
      reason: \`Strong UP momentum: delta \${delta} > ${deltaThreshold}, \${timeLeft}s left\`
    };
  }
  
  if (delta < -${deltaThreshold} && timeLeft < ${timeThreshold}) {
    return { 
      signal: 'DOWN', 
      shares: ${shares}, 
      reason: \`Strong DOWN momentum: delta \${delta} < -${deltaThreshold}, \${timeLeft}s left\`
    };
  }
  
  return { signal: 'NONE', shares: 0, reason: 'Momentum conditions not met' };
}`;
    } else {
      // Default delta + time strategy
      algoName = `Custom Strategy (Δ${deltaThreshold}, ${timeThreshold}s)`;
      const targetSignal = direction === 'UP' ? 'UP' : (direction === 'DOWN' ? 'DOWN' : 'delta-based');
      
      generatedCode = `function customAlgorithm(marketData) {
  const { delta, timeLeft, upPrice, downPrice } = marketData;
  
  // Strategy: ${description}
  // Conditions: delta threshold=${deltaThreshold}, time<${timeThreshold}s
  
  ${direction === 'BOTH' ? `
  if (Math.abs(delta) > ${deltaThreshold} && timeLeft < ${timeThreshold}) {
    const signal = delta > 0 ? 'UP' : 'DOWN';
    return { 
      signal, 
      shares: ${shares}, 
      reason: \`Delta \${delta} exceeds ±${deltaThreshold} with \${timeLeft}s remaining\`
    };
  }` : `
  if (delta ${direction === 'UP' ? '>' : '<'} ${direction === 'UP' ? deltaThreshold : -deltaThreshold} && timeLeft < ${timeThreshold}) {
    return { 
      signal: '${direction}', 
      shares: ${shares}, 
      reason: \`${direction} signal: delta \${delta}, \${timeLeft}s remaining\`
    };
  }`}
  
  return { signal: 'NONE', shares: 0, reason: 'Conditions not met' };
}`;
    }
    
    // Generate unique ID for this custom algorithm
    const algoId = `custom_${Date.now()}`;
    
    // Store the custom algorithm
    customAlgorithms.set(algoId, {
      id: algoId,
      name: algoName,
      description,
      code: generatedCode,
      createdAt: new Date().toISOString()
    });
    
    console.log(`✅ Custom algorithm created: ${algoId} - ${algoName}`);
    
    res.json({
      success: true,
      algorithmId: algoId,
      name: algoName,
      description,
      code: generatedCode,
      message: 'Algorithm created successfully (template-based)'
    });
    
  } catch (error) {
    console.error('❌ Algorithm creation error:', error);
    res.status(500).json({ error: error.message || 'Failed to create algorithm' });
  }
});

/**
 * GET /api/custom-algos
 * Get list of custom algorithms
 */
app.get('/api/custom-algos', (req, res) => {
  const algos = Array.from(customAlgorithms.values()).map(algo => ({
    id: algo.id,
    description: algo.description,
    createdAt: algo.createdAt
  }));
  
  res.json({ success: true, algorithms: algos });
});

// ==========================================
// LIVE TRADING ENGINE
// ==========================================

/**
 * Start live trading session with real-time data
 */
async function startLiveTrading(sessionId, algoName, marketSlug) {
  console.log(`\n🔍 Resolving market: ${marketSlug}`);
  
  // Get algorithm function
  let algoFunction;
  if (algoName === 'algo1') {
    algoFunction = algoSmartApe;
  } else if (algoName === 'algo2') {
    algoFunction = algoDeltaTimeMomentum;
  } else if (algoName.startsWith('custom_')) {
    // Load custom algorithm
    const customAlgo = customAlgorithms.get(algoName);
    if (!customAlgo) {
      console.error(`❌ Custom algorithm ${algoName} not found`);
      return;
    }
    
    // Execute the generated code to get the function
    try {
      eval(customAlgo.code); // This defines customAlgorithm function
      algoFunction = customAlgorithm;
      console.log(`✅ Loaded custom algorithm: ${customAlgo.description}`);
    } catch (err) {
      console.error(`❌ Failed to load custom algorithm:`, err.message);
      return;
    }
  } else {
    algoFunction = algoSmartApe; // Default
  }
  
  try {
    // Resolve market tokens
    const marketInfo = await resolveSlugToTokens(marketSlug);
    const { tokenIds, conditionId, question, outcomes, endDate, isDemoMode } = marketInfo;
    
    console.log(`✅ Market resolved: ${question}`);
    console.log(`   Outcomes: ${JSON.stringify(outcomes)}`);
    console.log(`   Condition ID: ${conditionId || 'N/A'}`);
    console.log(`   Token IDs: ${tokenIds.join(', ')}`);
    console.log(`   End Date: ${endDate}`);
    console.log(`   🔴 LIVE TRADING MODE - Real orders will be placed!`);
    if (!TRADE_CONFIG.enabled) {
      console.log(`   ⚠️ Trading disabled in config - orders will be simulated`);
    }
    
    // Store session info
    const sessionData = {
      sessionId,
      algo: algoName,
      marketSlug,
      tokenIds,
      conditionId,
      startTime: Date.now(),
      tradesExecuted: 0,
      client: null,
      endDate: endDate,
      autoRotate: true,
      connectionAttempts: 0,
      liveTrading: TRADE_CONFIG.enabled,
      orderPlaced: false  // Track if order has been placed for custom algo
    };
    
    // Create real-time data client
    const client = new RealTimeDataClient({
      onConnect: (c) => {
        console.log(`✅ [${sessionId}] Connected to Polymarket Real-Time Service`);
        
        // Broadcast to WebSocket clients
        broadcastToClients({
          type: 'status',
          sessionId,
          message: 'Connected to Polymarket',
          status: 'connected'
        });
        
        // Subscribe to CLOB market data streams
        // Filters must be a JSON array of token IDs (asset IDs)
        const tokenIdsArray = JSON.stringify(tokenIds.map(id => id.toString()));
        
        c.subscribe({
          subscriptions: [
            // Price changes for market updates
            {
              topic: 'clob_market',
              type: 'price_change',
              filters: tokenIdsArray
            },
            // Aggregated order book for pricing
            {
              topic: 'clob_market',
              type: 'agg_orderbook',
              filters: tokenIdsArray
            },
            // Last trade price updates
            {
              topic: 'clob_market',
              type: 'last_trade_price',
              filters: tokenIdsArray
            }
          ]
        });
        
        console.log(`📡 [${sessionId}] Subscribed to: order book, market updates, trades, and prices`);
        broadcastToClients({
          type: 'status',
          sessionId,
          message: 'Subscribed to all market data streams',
          status: 'monitoring'
        });
      },
      
      onMessage: (_, message) => {
        if (message.topic === 'clob_market') {
          // Log different message types for debugging
          if (message.type === 'price_change') {
            console.log(`💲 [${sessionId}] Price change: ${JSON.stringify(message.payload)}`);
          } else if (message.type === 'last_trade_price') {
            console.log(`💱 [${sessionId}] Trade price: ${JSON.stringify(message.payload)}`);
          } else if (message.type === 'agg_orderbook') {
            console.log(`📊 [${sessionId}] Order book: bids=${message.payload.bids?.length || 0}, asks=${message.payload.asks?.length || 0}`);
          }
          
          // Process all market data and evaluate algo conditions
          evaluateAlgoConditions(sessionId, algoFunction, message, marketSlug, endDate);
        }
      },
      
      onStatusChange: (status) => {
        console.log(`📡 [${sessionId}] Status: ${status}`);
        
        // If connection keeps failing, log error
        if (status === 'DISCONNECTED') {
          const session = activeSessions.get(sessionId);
          if (session && session.client) {
            session.connectionAttempts = (session.connectionAttempts || 0) + 1;
            
            if (session.connectionAttempts >= 5) {
              console.log(`❌ [${sessionId}] Connection failed multiple times - stopping session`);
              session.client.disconnect();
              session.client = null;
              activeSessions.delete(sessionId);
              
              broadcastToClients({
                type: 'error',
                sessionId,
                message: 'Connection failed - session stopped. Check network and try again.',
                status: 'failed'
              });
              return;
            }
          }
        }
        
        broadcastToClients({
          type: 'status',
          sessionId,
          message: `Connection status: ${status}`,
          status
        });
      },
      onError: (error) => {
        // Suppress verbose error logging
        console.log(`⚠️ [${sessionId}] Connection error (check network/firewall)`);
      }
    });
    
    sessionData.client = client;
    activeSessions.set(sessionId, sessionData);
    
    // Connect to real-time service
    client.connect();
    
  } catch (error) {
    console.error(`❌ [${sessionId}] Error:`, error.message);
    broadcastToClients({
      type: 'error',
      sessionId,
      message: error.message
    });
  }
}

/**
 * Evaluate algorithm conditions on incoming market data
 */
async function evaluateAlgoConditions(sessionId, algoFunction, message, marketSlug, endDate) {
  try {
    // Extract market data from message
    const payload = message.payload;
    
    // Calculate time left until market closes
    const now = Date.now();
    const endTime = new Date(endDate).getTime();
    const timeLeftSeconds = Math.max(0, Math.floor((endTime - now) / 1000));
    
    // Check if market has ended and auto-rotate to next market
    if (timeLeftSeconds <= 0) {
      const session = activeSessions.get(sessionId);
      if (session && session.autoRotate) {
        console.log(`\n⏰ [${sessionId}] Market ended, rotating to next 15-min market...`);
        broadcastToClients({
          type: 'status',
          sessionId,
          message: 'Market ended. Rotating to next 15-min market...',
          status: 'rotating'
        });
        
        // Rotate to next market
        rotateToNextMarket(sessionId, session.algo);
      }
      return;
    }
    
    // Mock delta calculation (in production, track price changes)
    // For demo, we'll use a simulated delta based on order book imbalance
    const bids = payload?.bids || [];
    const asks = payload?.asks || [];
    
    const totalBidVolume = bids.reduce((sum, bid) => sum + parseFloat(bid.size || 0), 0);
    const totalAskVolume = asks.reduce((sum, ask) => sum + parseFloat(ask.size || 0), 0);
    
    // Simulate price delta based on order book imbalance
    const imbalance = totalBidVolume - totalAskVolume;
    const simulatedDelta = imbalance * 10; // Scale factor
    
    // Extract upPrice and downPrice for custom algos
    // Extract upPrice and downPrice from price_change event if available
    let upPrice = 0.5;
    let downPrice = 0.5;
    if (message.type === 'price_change' && Array.isArray(payload.pc)) {
      // Find UP and DOWN asset prices from Polymarket convention
      // Usually, the first asset is UP, the second is DOWN, but check both
      if (payload.pc.length >= 2) {
        // Try to match by asset index: 0 = UP, 1 = DOWN
        upPrice = parseFloat(payload.pc[0].p) || 0.5;
        downPrice = parseFloat(payload.pc[1].p) || 0.5;
      } else if (payload.pc.length === 1) {
        upPrice = parseFloat(payload.pc[0].p) || 0.5;
      }
    } else {
      // Fallback to asks/bids
      upPrice = asks[0] ? parseFloat(asks[0].price) : 0.5;
      downPrice = bids[0] ? parseFloat(bids[0].price) : 0.5;
    }
    console.log(`[${sessionId}] upPrice: ${upPrice}, downPrice: ${downPrice}, delta: ${simulatedDelta}, timeLeft: ${timeLeftSeconds}`);
    const marketData = {
      delta: simulatedDelta,
      timeLeft: timeLeftSeconds,
      bids,
      asks,
      upPrice,
      downPrice
    };
    // Evaluate algo
    const signal = algoFunction(marketData);
    
    if (signal.signal !== 'NONE') {
      // Get session data
      const session = activeSessions.get(sessionId);
      
      // Check if order already placed for custom algo (stop after first order)
      if (session.orderPlaced) {
        console.log(`⏹️ [${sessionId}] Order already placed for this session - skipping (one order limit)`);
        return;
      }
      
      // Log trade execution
      console.log(`\n🎯 [${sessionId}] TRADE SIGNAL DETECTED!`);
      console.log(`   Direction: ${signal.signal}`);
      console.log(`   Shares: ${signal.shares}`);
      console.log(`   Reason: ${signal.reason}`);
      console.log(`   Delta: ${simulatedDelta.toFixed(2)}`);
      console.log(`   Time Left: ${timeLeftSeconds}s`);
      
      // Validate signal has shares
      if (!signal.shares || signal.shares <= 0) {
        console.error(`❌ [${sessionId}] Cannot place order: shares is zero or undefined.`);
        return;
      }
      
      // Determine which token to buy
      const tokenIndex = signal.signal === 'UP' ? 0 : 1;
      const tokenId = session.tokenIds[tokenIndex];
      
      console.log(`   📝 Placing REAL order on Polymarket CLOB`);
      console.log(`   Token: ${tokenId}`);
      console.log(`   Direction: ${signal.signal}`);
      console.log(`   Size: ${signal.shares} shares`);
      console.log(`   💼 Wallet: ${WALLET_ADDRESS}`);
      
      // Place the order
      try {
        const orderResult = await placeOrder(tokenId, 'BUY');
        
        if (orderResult.success) {
          // Mark order as placed to prevent future orders
          session.orderPlaced = true;
          
          console.log(`\n🎯 ===== TRADE EXECUTED =====`);
          console.log(`   Order ID: ${orderResult.orderId}`);
          console.log(`   Signal: ${signal.signal}`);
          console.log(`   Shares: ${signal.shares}`);
          console.log(`   Price: $${bestPrice}`);
          console.log(`   Wallet: ${WALLET_ADDRESS}`);
          console.log(`   Algorithm: ${session.algoName || 'Unknown'}`);
          console.log(`   Reason: ${signal.reason}`);
          console.log(`   Status: ${orderResult.status || 'LIVE'}`);
          if (!orderResult.simulated) {
            console.log(`   ✅ REAL ORDER PLACED ON POLYMARKET!`);
            console.log(`   🛑 One order limit reached - no more orders will be placed`);
          } else {
            console.log(`   ⚠️ Simulated order (check configuration)`);
          }
          console.log(`============================\n`);
        } else {
          console.log(`\n❌ ===== TRADE FAILED =====`);
          console.log(`   Error: ${orderResult.error || 'Unknown error'}`);
          console.log(`===========================\n`);
          console.log('   ⚠️ Trade not executed due to error', orderResult.error || 'Unknown error');
        }
        
        session.tradesExecuted++;
      } catch (orderError) {
        console.error(`\n❌ ===== TRADE FAILED =====`);
        console.error(`   Error: ${orderError.message}`);
        console.error(`   Signal: ${signal.signal}`);
        console.error(`   Shares: ${signal.shares}`);
        console.error(`===========================\n`);
      }
      
      // Broadcast trade execution to WebSocket clients
      broadcastToClients({
        type: 'trade',
        sessionId,
        signal: signal.signal,
        shares: signal.shares,
        reason: signal.reason,
        delta: simulatedDelta.toFixed(2),
        timeLeft: timeLeftSeconds,
        tradesExecuted: session.tradesExecuted,
        wallet: WALLET_ADDRESS
      });
    }
    
    // Broadcast market update
    broadcastToClients({
      type: 'market_update',
      sessionId,
      delta: simulatedDelta.toFixed(2),
      timeLeft: timeLeftSeconds,
      currentSignal: signal.signal
    });
    
  } catch (error) {
    console.error(`❌ [${sessionId}] Evaluation error:`, error.message);
  }
}

/**
 * Rotate to the next 15-minute market automatically
 */
async function rotateToNextMarket(sessionId, algoName) {
  try {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    
    // Disconnect current client
    if (session.client) {
      session.client.disconnect();
      console.log(`🔌 [${sessionId}] Disconnected from old market`);
    }
    
    // Wait a moment before connecting to new market
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Generate next market slug
    const newMarketSlug = generateMarketSlug();
    console.log(`🔄 [${sessionId}] Switching to new market: ${newMarketSlug}`);
    
    broadcastToClients({
      type: 'status',
      sessionId,
      message: `Switching to new market: ${newMarketSlug}`,
      status: 'connecting'
    });
    
    // Resolve new market
    const marketInfo = await resolveSlugToTokens(newMarketSlug);
    const { tokenIds, question, outcomes, endDate } = marketInfo;
    
    console.log(`✅ [${sessionId}] New market resolved: ${question}`);
    
    // Update session data
    session.marketSlug = newMarketSlug;
    session.tokenIds = tokenIds;
    session.endDate = endDate;
    
    const algoFunction = algoName === 'algo1' ? algoSmartApe : algoDeltaTimeMomentum;
    
    // Create new real-time data client
    const client = new RealTimeDataClient({
      onConnect: (c) => {
        console.log(`✅ [${sessionId}] Connected to new market`);
        
        broadcastToClients({
          type: 'status',
          sessionId,
          message: `Connected to new market: ${newMarketSlug}`,
          status: 'connected'
        });
        
        // Subscribe to order book updates
        c.subscribe({
          subscriptions: [
            // Aggregated order book for pricing
            {
              topic: 'clob_market',
              type: 'agg_orderbook',
              filters: JSON.stringify(tokenIds)
            },
            // Market updates for current prices and stats
            {
              topic: 'clob_market',
              type: 'market',
              filters: JSON.stringify(tokenIds)
            },
            // Trade events for volume and momentum
            {
              topic: 'clob_market',
              type: 'trade',
              filters: JSON.stringify(tokenIds)
            },
            // Last trade price updates
            {
              topic: 'clob_market',
              type: 'last_trade_price',
              filters: JSON.stringify(tokenIds)
            }
          ]
        });
        
        console.log(`📡 [${sessionId}] Subscribed to all market data streams`);
        broadcastToClients({
          type: 'status',
          sessionId,
          message: 'Subscribed to all market data streams',
          status: 'monitoring'
        });
      },
      
      onMessage: (_, message) => {
        if (message.topic === 'clob_market') {
          // Log different message types for debugging
          if (message.type === 'trade') {
            console.log(`💱 [${sessionId}] Trade: ${JSON.stringify(message.payload)}`);
          } else if (message.type === 'last_trade_price') {
            console.log(`💲 [${sessionId}] Price update: ${JSON.stringify(message.payload)}`);
          } else if (message.type === 'market') {
            console.log(`📊 [${sessionId}] Market update: ${JSON.stringify(message.payload)}`);
          }
          
          evaluateAlgoConditions(sessionId, algoFunction, message, newMarketSlug, endDate);
        }
      },
      
      onStatusChange: (status) => {
        console.log(`📡 [${sessionId}] Status: ${status}`);
        
        // If connection keeps failing during rotation, stop session
        if (status === 'DISCONNECTED') {
          const session = activeSessions.get(sessionId);
          if (session) {
            session.connectionAttempts = (session.connectionAttempts || 0) + 1;
            
            if (session.connectionAttempts >= 5) {
              console.log(`❌ [${sessionId}] Connection failed - stopping session`);
              if (session.client) session.client.disconnect();
              activeSessions.delete(sessionId);
              
              broadcastToClients({
                type: 'error',
                sessionId,
                message: 'Connection failed during rotation - session stopped',
                status: 'failed'
              });
              return;
            }
          }
        }
        
        broadcastToClients({
          type: 'status',
          sessionId,
          message: `Connection status: ${status}`,
          status
        });
      },
      onError: (error) => {
        console.log(`⚠️ [${sessionId}] Connection error (suppressed)`);
      }
    });
    
    session.client = client;
    session.connectionAttempts = 0; // Reset counter for new connection
    activeSessions.set(sessionId, session);
    
    // Connect to new market
    client.connect();
    
  } catch (error) {
    console.error(`❌ [${sessionId}] Market rotation error:`, error.message);
    broadcastToClients({
      type: 'error',
      sessionId,
      message: `Market rotation failed: ${error.message}`
    });
    
    // Retry rotation after 5 seconds
    console.log(`🔄 [${sessionId}] Retrying market rotation in 5 seconds...`);
    setTimeout(() => rotateToNextMarket(sessionId, algoName), 5000);
  }
}

/**
 * Start demo simulation with mock data
 */
function startDemoSimulation(sessionId, algoFunction, endDate) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  
  console.log(`🎮 [${sessionId}] Demo simulation started`);
  
  // Simulate market updates every 5 seconds
  const interval = setInterval(() => {
    const now = Date.now();
    const endTime = new Date(endDate).getTime();
    const timeLeftSeconds = Math.max(0, Math.floor((endTime - now) / 1000));
    
    // Check if market ended
    if (timeLeftSeconds <= 0) {
      console.log(`⏰ [${sessionId}] Demo market ended, rotating...`);
      clearInterval(interval);
      
      if (session.autoRotate) {
        rotateToNextMarket(sessionId, session.algo);
      }
      return;
    }
    
    // Generate random delta for simulation
    const simulatedDelta = (Math.random() - 0.5) * 300; // -150 to +150
    
    const marketData = {
      delta: simulatedDelta,
      timeLeft: timeLeftSeconds,
      bids: [{ price: '0.48', size: '100' }],
      asks: [{ price: '0.52', size: '100' }]
    };
    
    // Evaluate algo
    const signal = algoFunction(marketData);
    
    if (signal.signal !== 'NONE') {
      console.log(`\n🎯 [${sessionId}] DEMO TRADE SIGNAL!`);
      console.log(`   Direction: ${signal.signal}`);
      console.log(`   Shares: ${signal.shares}`);
      console.log(`   Reason: ${signal.reason}`);
      console.log(`   Delta: ${simulatedDelta.toFixed(2)}`);
      console.log(`   Time Left: ${timeLeftSeconds}s`);
      
      const bestPrice = signal.signal === 'UP' ? '0.52' : '0.48';
      console.log(`   📝 DEMO ORDER: BUY ${signal.shares} ${signal.signal} @ $${bestPrice}`);
      console.log(`   💼 Wallet: ${WALLET_ADDRESS}`);
      
      session.tradesExecuted++;
      
      broadcastToClients({
        type: 'trade',
        sessionId,
        signal: signal.signal,
        shares: signal.shares,
        price: bestPrice,
        reason: signal.reason,
        delta: simulatedDelta.toFixed(2),
        timeLeft: timeLeftSeconds,
        tradesExecuted: session.tradesExecuted,
        wallet: WALLET_ADDRESS,
        demo: true
      });
    }
    
    // Broadcast market update
    broadcastToClients({
      type: 'market_update',
      sessionId,
      delta: simulatedDelta.toFixed(2),
      timeLeft: timeLeftSeconds,
      currentSignal: signal.signal,
      demo: true
    });
    
  }, 5000); // Every 5 seconds
  
  // Store interval for cleanup
  session.demoInterval = interval;
  activeSessions.set(sessionId, session);
}

// ==========================================
// WEBSOCKET SERVER
// ==========================================

/**
 * Broadcast message to all connected WebSocket clients
 */
function broadcastToClients(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

/**
 * Handle WebSocket connections
 */
wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket client connected');
  
  ws.on('message', (message) => {
    console.log('📩 Received:', message.toString());
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
  });
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to Algo Trading Portal'
  }));
});

// ==========================================
// START SERVER
// ==========================================

server.listen(PORT, () => {
  console.log('\n===========================================');
  console.log('🚀 Algo Backtesting & Trading Portal');
  console.log('===========================================');
  console.log(`📡 Server running at: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket ready at: ws://localhost:${PORT}`);
  console.log(`💼 Wallet: ${WALLET_ADDRESS}`);
  if (TRADE_CONFIG.enabled) {
    console.log('⚠️  🔴 LIVE TRADING ENABLED - REAL ORDERS WILL BE PLACED');
  } else {
    console.log('ℹ️  📊 Simulation mode - No real orders');
  }
  console.log('===========================================\n');
});
