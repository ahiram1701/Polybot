/**
 * validate_first_ticks.js
 * 
 * Valida la estrategia de "primeros N ticks como señal" contra analytics.jsonl
 * 
 * Hipótesis: Los primeros ticks de la ventana (segundos después de abrir la vela)
 * tienen correlación direccional con el resultado final.
 * 
 * Estrategia: Si los primeros N ticks son mayoritariamente UP (price > openingPrice),
 * comprar UP. Si son DOWN, comprar DOWN.
 * 
 * Variantes a probar:
 * - N = 1, 2, 3, 5 ticks
 * - Señal por mayoría simple
 * - Señal por unanimidad (todos los ticks en misma dirección)
 * - Señal por distancia acumulada
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'analytics.jsonl');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'first_ticks_validation.json');

function loadSamples() {
  const lines = fs.readFileSync(DATA_FILE, 'utf8').split('\n').filter(l => l.trim());
  const samples = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'analytics_sample' && parsed.sample) {
        samples.push(parsed.sample);
      }
    } catch (e) {
      // skip malformed lines
    }
  }
  return samples;
}

function analyzeStrategy(samples, tickCount, strategy) {
  /**
   * strategy: 'majority' | 'unanimous' | 'first_tick' | 'cumulative_distance'
   */
  let wins = 0;
  let losses = 0;
  let skips = 0;
  const results = [];

  for (const sample of samples) {
    const { ticks, openingPrice, winningOutcome, market } = sample;
    
    if (!ticks || ticks.length < tickCount) {
      skips++;
      continue;
    }

    // Los ticks vienen ordenados por timestamp ascendente (más viejos primero)
    // secondsToEnd más alto = más cercano a apertura
    const firstTicks = ticks.slice(0, tickCount);
    
    let predictedOutcome;
    
    switch (strategy) {
      case 'first_tick': {
        // Solo el primer tick
        const firstTick = firstTicks[0];
        predictedOutcome = firstTick.distanceUsd < 0 ? 'DOWN' : 'UP';
        break;
      }
      case 'majority': {
        // Mayoría simple
        const upCount = firstTicks.filter(t => t.distanceUsd >= 0).length;
        const downCount = firstTicks.length - upCount;
        if (upCount === downCount) {
          skips++;
          continue;
        }
        predictedOutcome = upCount > downCount ? 'UP' : 'DOWN';
        break;
      }
      case 'unanimous': {
        // Todos en misma dirección
        const allUp = firstTicks.every(t => t.distanceUsd >= 0);
        const allDown = firstTicks.every(t => t.distanceUsd < 0);
        if (!allUp && !allDown) {
          skips++;
          continue;
        }
        predictedOutcome = allUp ? 'UP' : 'DOWN';
        break;
      }
      case 'cumulative_distance': {
        // Suma de distancias
        const totalDistance = firstTicks.reduce((sum, t) => sum + t.distanceUsd, 0);
        if (Math.abs(totalDistance) < 0.001) {
          skips++;
          continue;
        }
        predictedOutcome = totalDistance >= 0 ? 'UP' : 'DOWN';
        break;
      }
      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    const isWin = predictedOutcome === winningOutcome;
    if (isWin) wins++;
    else losses++;
    
    results.push({
      market,
      slug: sample.slug,
      openingPrice,
      winningOutcome,
      predictedOutcome,
      isWin,
      firstTickPrices: firstTicks.map(t => t.price),
      firstTickDistances: firstTicks.map(t => t.distanceUsd),
      firstTickSecondsToEnd: firstTicks.map(t => t.secondsToEnd),
    });
  }

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100).toFixed(2) : 'N/A';
  
  return {
    strategy,
    tickCount,
    totalSamples: samples.length,
    trades: total,
    skips,
    wins,
    losses,
    winRate: `${winRate}%`,
  };
}

function analyzeByMarket(samples, tickCount, strategy) {
  const markets = {};
  
  for (const sample of samples) {
    const market = sample.market || 'UNKNOWN';
    if (!markets[market]) markets[market] = [];
    markets[market].push(sample);
  }
  
  const results = {};
  for (const [market, marketSamples] of Object.entries(markets)) {
    results[market] = analyzeStrategy(marketSamples, tickCount, strategy);
  }
  return results;
}

function main() {
  console.log('Loading samples...');
  const samples = loadSamples();
  console.log(`Loaded ${samples.length} samples\n`);

  const strategies = ['first_tick', 'majority', 'unanimous', 'cumulative_distance'];
  const tickCounts = [1, 2, 3, 5];
  
  const allResults = {
    generatedAt: new Date().toISOString(),
    totalSamples: samples.length,
    results: {},
    byMarket: {},
  };

  // Global results
  for (const strategy of strategies) {
    allResults.results[strategy] = {};
    for (const n of tickCounts) {
      allResults.results[strategy][`${n}_ticks`] = analyzeStrategy(samples, n, strategy);
    }
  }

  // By market (best strategy: first_tick with 3 ticks)
  allResults.byMarket = analyzeByMarket(samples, 3, 'first_tick');

  // Detailed: first_tick with 3 ticks for BTC
  const btcSamples = samples.filter(s => s.market === 'BTC');
  const ethSamples = samples.filter(s => s.market === 'ETH');
  const dogeSamples = samples.filter(s => s.market === 'DOGE');

  allResults.detailed = {
    btc: {
      total: btcSamples.length,
      firstTick3: analyzeStrategy(btcSamples, 3, 'first_tick'),
      firstTick1: analyzeStrategy(btcSamples, 1, 'first_tick'),
      majority3: analyzeStrategy(btcSamples, 3, 'majority'),
      unanimous3: analyzeStrategy(btcSamples, 3, 'unanimous'),
    },
    eth: {
      total: ethSamples.length,
      firstTick3: analyzeStrategy(ethSamples, 3, 'first_tick'),
      firstTick1: analyzeStrategy(ethSamples, 1, 'first_tick'),
    },
    doge: {
      total: dogeSamples.length,
      firstTick3: analyzeStrategy(dogeSamples, 3, 'first_tick'),
      firstTick1: analyzeStrategy(dogeSamples, 1, 'first_tick'),
    },
  };

  // ROI estimation (assumes 80% payout, $100 per trade)
  const PAYOUT = 0.80;
  const TRADE_SIZE = 100;
  
  for (const [label, data] of Object.entries(allResults.detailed)) {
    for (const [stratName, stratData] of Object.entries(data)) {
      if (typeof stratData === 'object' && stratData.wins !== undefined) {
        const total = stratData.wins + stratData.losses;
        if (total > 0) {
          const netProfit = stratData.wins * (TRADE_SIZE * PAYOUT) - stratData.losses * TRADE_SIZE;
          const roi = (netProfit / (total * TRADE_SIZE)) * 100;
          stratData.roiEstimate = `${roi.toFixed(2)}%`;
          stratData.netProfitUsd = netProfit;
        }
      }
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allResults, null, 2));
  console.log(`Results saved to ${OUTPUT_FILE}`);
  
  // Print summary
  console.log('\n=== SUMMARY ===');
  for (const [strategy, tickResults] of Object.entries(allResults.results)) {
    console.log(`\n--- ${strategy} ---`);
    for (const [label, data] of Object.entries(tickResults)) {
      console.log(`  ${label}: ${data.winRate} (${data.wins}W/${data.losses}L, ${data.skips} skips)`);
    }
  }

  console.log('\n=== BY MARKET (first_tick, 3 ticks) ===');
  for (const [market, data] of Object.entries(allResults.byMarket)) {
    console.log(`  ${market}: ${data.winRate} (${data.wins}W/${data.losses}L)`);
  }

  console.log('\n=== ROI ESTIMATES (80% payout, $100/trade) ===');
  for (const [label, data] of Object.entries(allResults.detailed)) {
    console.log(`\n--- ${label.toUpperCase()} ---`);
    for (const [stratName, stratData] of Object.entries(data)) {
      if (stratData.roiEstimate) {
        console.log(`  ${stratName}: ${stratData.winRate} → ROI ${stratData.roiEstimate} ($${stratData.netProfitUsd})`);
      }
    }
  }
}

main();
