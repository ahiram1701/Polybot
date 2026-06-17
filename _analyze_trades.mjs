const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/DEV/tests/Workspace de Yarbis/Polybot/_trades_raw.json','utf8'));
const t = data.trades;
const tot = t.length;
const won = t.filter(x=>x.resolved&&x.resolved.won).length;
const lost = t.filter(x=>x.resolved&&!x.resolved.won).length;
const pending = t.filter(x=>!x.resolved).length;
const results = [];
results.push('Total:'+tot+' Won:'+won+' Lost:'+lost+' Pend:'+pending);
if(won+lost>0) results.push('WR:'+(won/(won+lost)*100).toFixed(1)+'%');

['BTC','ETH','DOGE'].forEach(asset => {
  const m = t.filter(x=>x.asset===asset);
  const mW = m.filter(x=>x.resolved&&x.resolved.won).length;
  const mL = m.filter(x=>x.resolved&&!x.resolved.won).length;
  results.push(asset+':'+m.length+'t '+mW+'W/'+mL+'L WR:'+(mW+mL>0?(mW/(mW+mL)*100).toFixed(1):'N/A')+'%');
});

['UP','DOWN'].forEach(dir => {
  const g = t.filter(x=>x.outcome===dir);
  const gW = g.filter(x=>x.resolved&&x.resolved.won).length;
  const gL = g.filter(x=>x.resolved&&!x.resolved.won).length;
  results.push(dir+':'+gW+'W/'+gL+'L WR:'+(gW+gL>0?(gW/(gW+gL)*100).toFixed(1):'N/A')+'%');
});

const askMap = {};
t.forEach(x => {
  const k = x.maxAskPrice;
  if(!askMap[k]) askMap[k]={total:0,won:0,lost:0};
  askMap[k].total++;
  if(x.resolved&&x.resolved.won) askMap[k].won++;
  if(x.resolved&&!x.resolved.won) askMap[k].lost++;
});
results.push('--- maxAskPrice ---');
Object.keys(askMap).sort().forEach(k => {
  const g=askMap[k];
  const wr = g.won+g.lost>0 ? (g.won/(g.won+g.lost)*100).toFixed(1) : 'N/A';
  results.push(' ask='+k+': '+g.total+'t '+g.won+'W/'+g.lost+'L WR='+wr+'%');
});

const dates = t.map(x=>new Date(x.createdAtMs).toISOString().slice(0,10));
const unique = [...new Set(dates)].sort();
results.push('Date range: '+unique[0]+' to '+unique[unique.length-1]+' ('+unique.length+' days)');

fs.writeFileSync('C:/DEV/tests/Workspace de Yarbis/Polybot/_trade_analysis.txt', results.join('\n'), 'utf8');
console.log('OK');