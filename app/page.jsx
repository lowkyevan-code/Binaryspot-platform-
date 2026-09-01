'use client';

import React, { useState, useEffect, useRef } from 'react';

const APP_ID = '1089';
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

export default function DBTradersBotPlatform() {
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [balance, setBalance] = useState(null);
  const [currency, setCurrency] = useState('USD');
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(false);

  const [symbol, setSymbol] = useState('R_100');
  const [lastTick, setLastTick] = useState(null);
  const [lastDigit, setLastDigit] = useState(null);

  const [strategy, setStrategy] = useState('CALL');
  const [baseStake, setBaseStake] = useState('1');
  const [currentStake, setCurrentStake] = useState('1');
  const [martingale, setMartingale] = useState('2.0');
  const [takeProfit, setTakeProfit] = useState('10');
  const [stopLoss, setStopLoss] = useState('20');
  const [duration, setDuration] = useState('1');
  const [predictionDigit, setPredictionDigit] = useState('5');

  const [isBotRunning, setIsBotRunning] = useState(false);
  const [totalProfit, setTotalProfit] = useState(0);
  const [winCount, setWinCount] = useState(0);
  const [lossCount, setLossCount] = useState(0);
  const [logs, setLogs] = useState([]);

  const wsRef = useRef(null);
  const botRunningRef = useRef(false);
  const totalProfitRef = useRef(0);
  const currentStakeRef = useRef(1);

  useEffect(() => {
    botRunningRef.current = isBotRunning;
  }, [isBotRunning]);

  useEffect(() => {
    totalProfitRef.current = totalProfit;
  }, [totalProfit]);

  useEffect(() => {
    currentStakeRef.current = parseFloat(currentStake) || 1;
  }, [currentStake]);

  const addLog = (msg, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] [${type.toUpperCase()}] ${msg}`, ...prev.slice(0, 70)]);
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const token1 = params.get('token1');
      const acct1 = params.get('acct1');

      if (token1 && acct1) {
        setToken(token1);
        setAccountId(acct1);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  }, []);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      addLog('WebSocket connected to Deriv network.', 'system');
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));

      if (token) {
        ws.send(JSON.stringify({ authorize: token }));
      }
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.msg_type === 'authorize') {
        if (data.error) {
          addLog(`Auth failed: ${data.error.message}`, 'error');
          setIsAuthorized(false);
        } else {
          setIsAuthorized(true);
          setAccountId(data.authorize.loginid);
          addLog(`Logged in as ${data.authorize.loginid}`, 'success');
          ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        }
      }

      if (data.msg_type === 'balance') {
        setBalance(data.balance.balance);
        setCurrency(data.balance.currency);
      }

      if (data.msg_type === 'tick' && data.tick) {
        const quote = data.tick.quote;
        setLastTick(quote);
        const strQuote = quote.toString();
        setLastDigit(strQuote.charAt(strQuote.length - 1));
      }

      if (data.msg_type === 'proposal') {
        if (data.error) {
          addLog(`Proposal error: ${data.error.message}`, 'error');
          if (botRunningRef.current) stopBot('Proposal rejected by broker');
        } else if (data.proposal) {
          ws.send(JSON.stringify({
            buy: data.proposal.id,
            price: data.proposal.ask_price
          }));
        }
      }

      if (data.msg_type === 'buy') {
        if (data.error) {
          addLog(`Execution error: ${data.error.message}`, 'error');
          if (botRunningRef.current) stopBot('Buy execution failed');
        } else {
          addLog(`Order active: Contract #${data.buy.contract_id}`, 'trade');
          ws.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: data.buy.contract_id,
            subscribe: 1
          }));
        }
      }

      if (data.msg_type === 'proposal_open_contract') {
        const contract = data.proposal_open_contract;
        if (contract && contract.is_sold) {
          const profit = parseFloat(contract.profit);
          handleTradeResult(profit > 0, profit);
        }
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setIsAuthorized(false);
      addLog('Connection lost. Reconnecting...', 'error');
    };

    return () => {
      ws.close();
    };
  }, [symbol]);

  const handleTradeResult = (isWin, profit) => {
    const newNetProfit = Number((totalProfitRef.current + profit).toFixed(2));
    setTotalProfit(newNetProfit);

    if (isWin) {
      setWinCount((w) => w + 1);
      addLog(`WON: +${profit} ${currency} | Session Net: ${newNetProfit}`, 'success');
      const base = parseFloat(baseStake) || 1;
      setCurrentStake(base.toString());
    } else {
      setLossCount((l) => l + 1);
      addLog(`LOST: ${profit} ${currency} | Session Net: ${newNetProfit}`, 'error');
      const mMultiplier = parseFloat(martingale) || 1;
      const nextStake = (currentStakeRef.current * mMultiplier).toFixed(2);
      setCurrentStake(nextStake.toString());
    }

    const tp = parseFloat(takeProfit);
    const sl = parseFloat(stopLoss);

    if (newNetProfit >= tp) {
      stopBot(`Target Take-Profit Reached (+${newNetProfit} ${currency})!`);
      return;
    }

    if (newNetProfit <= -sl) {
      stopBot(`Stop-Loss Hit (-${Math.abs(newNetProfit)} ${currency})!`);
      return;
    }

    if (botRunningRef.current) {
      setTimeout(() => {
        if (botRunningRef.current) {
          triggerNextTrade();
        }
      }, 700);
    }
  };

  const handleOAuthLogin = () => {
    const redirectUrl = window.location.origin;
    window.location.href = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}&l=en&brand=deriv&redirect_url=${encodeURIComponent(redirectUrl)}`;
  };

  const handleManualAuth = () => {
    if (!token || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ authorize: token }));
  };

  const triggerNextTrade = () => {
    if (!wsRef.current || !isAuthorized) {
      stopBot('Account not authorized');
      return;
    }

    const proposalPayload = {
      proposal: 1,
      amount: parseFloat(currentStakeRef.current),
      basis: 'stake',
      currency: currency,
      symbol: symbol,
      contract_type: strategy,
      duration: parseInt(duration, 10),
      duration_unit: 't'
    };

    if (['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(strategy)) {
      proposalPayload.barrier = predictionDigit;
    }

    addLog(`Sending ${strategy} order at stake ${currentStakeRef.current} ${currency}...`, 'trade');
    wsRef.current.send(JSON.stringify(proposalPayload));
  };

  const startBot = () => {
    if (!isAuthorized) {
      alert('Please connect your Deriv account or authorize with an API token first.');
      return;
    }
    setIsBotRunning(true);
    setCurrentStake(baseStake);
    addLog('Automated Bot Started.', 'system');
    setTimeout(() => {
      triggerNextTrade();
    }, 200);
  };

  const stopBot = (reason = 'Manual stop') => {
    setIsBotRunning(false);
    addLog(`Bot Stopped: ${reason}`, 'system');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4 bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-center text-emerald-400 font-black text-xl">
              BS
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-100">BinarySpot Engine</h1>
              <p className="text-xs text-slate-400">Automated WebSocket Trading Terminal</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
              <span className="text-xs text-slate-400">{isConnected ? 'Broker Live' : 'Disconnected'}</span>
            </div>

            {isAuthorized ? (
              <div className="bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-700 text-right">
                <p className="text-[11px] text-slate-400 uppercase font-mono">{accountId}</p>
                <p className="text-sm font-bold text-emerald-400">{balance !== null ? `${balance} ${currency}` : '...'}</p>
              </div>
            ) : (
              <button
                onClick={handleOAuthLogin}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs uppercase tracking-wider rounded-xl transition"
              >
                Connect Deriv
              </button>
            )}
          </div>
        </header>

        {!isAuthorized && (
          <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl flex flex-wrap gap-3 items-center">
            <input
              type="password"
              placeholder="Or paste Deriv API Token (Scopes required: read, trade)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="flex-1 bg-slate-800 border border-slate-700 px-3 py-2 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={handleManualAuth}
              className="px-5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-semibold rounded-lg"
            >
              Authorize Token
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <p className="text-xs text-slate-400">Live Tick ({symbol})</p>
            <p className="text-2xl font-mono font-bold text-amber-400 mt-1">{lastTick ?? '—'}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <p className="text-xs text-slate-400">Last Digit</p>
            <p className="text-2xl font-mono font-bold text-cyan-400 mt-1">{lastDigit ?? '—'}</p>
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <p className="text-xs text-slate-400">Win / Loss Ratio</p>
            <p className="text-2xl font-mono font-bold mt-1 text-slate-200">
              <span className="text-emerald-400">{winCount}W</span> / <span className="text-rose-400">{lossCount}L</span>
            </p>
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <p className="text-xs text-slate-400">Session Net P/L</p>
            <p className={`text-2xl font-mono font-bold mt-1 ${totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {totalProfit >= 0 ? `+${totalProfit}` : totalProfit} {currency}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-6">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">Bot Strategy & Risk Management</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-slate-400">Synthetic Asset</label>
                <select
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  disabled={isBotRunning}
                  className="w-full mt-1.5 bg-slate-800 border border-slate-700 p-2.5 rounded-xl text-sm"
                >
                  <option value="R_100">Volatility 100 Index</option>
                  <option value="R_50">Volatility 50 Index</option>
                  <option value="R_25">Volatility 25 Index</option>
                  <option value="1HZ100V">Volatility 100 (1s) Index</option>
                  <option value="1HZ50V">Volatility 50 (1s) Index</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400">Strategy Type</label>
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                  disabled={isBotRunning}
                  className="w-full mt-1.5 bg-slate-800 border border-slate-700 p-2.5 rounded-xl text-sm"
                >
                  <option value="CALL">Rise (Higher)</option>
                  <option value="PUT">Fall (Lower)</option>
                  <option value="DIGITEVEN">Digit Even</option>
                  <option value="DIGITODD">Digit Odd</option>
                  <option value="DIGITDIFF">Digit Differs</option>
                  <option value="DIGITMATCH">Digit Matches</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400">Initial Stake ({currency})</label>
                <input
                  type="number"
                  step="0.5"
                  value={baseStake}
                  onChange={(e) => setBaseStake(e.target.value)}
                  disabled={isBotRunning}
                  className="w-full mt-1.5 bg-slate-800 border border-slate-700 p-2.5 rounded-xl text-sm font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400">Martingale Multiplier (on loss)</label>
                <input
                  type="number"
                  step="0.1"
                  value={martingale}
                  onChange={(e) => setMartingale(e.target.value)}
                  disabled={isBotRunning}
                  className="w-full mt-1.5 bg-slate-800 border border-slate-700 p-2.5 rounded-xl text-sm font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-emerald-400">Take Profit Target ({currency})</label>
                <input
                  type="number"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  disabled={isBotRunning}
                  className="w-full mt-1.5 bg-slate-800 border border-slate-700 p-2.5 rounded-xl text-sm font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-rose-400">Stop Loss Max ({currency})</label>
                <input
                  type="number"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  disabled={isBotRunning}
                  className="w-full mt-1.5 bg-slate-800 border border-slate-700 p-2.5 rounded-xl text-sm font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400">Contract Ticks (1 - 10)</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  disabled={isBotRunning}
                  className="w-full mt-1.5 bg-slate-800 border border-slate-700 p-2.5 rounded-xl text-sm font-mono"
                />
              </div>

              {['DIGITDIFF', 'DIGITMATCH'].includes(strategy) && (
                <div>
                  <label className="text-xs font-medium text-slate-400">Prediction Digit (0 - 9)</label>
                  <input
                    type="number"
                    min="0"
                    max="9"
                    value={predictionDigit}
                    onChange={(e) => setPredictionDigit(e.target.value)}
                    disabled={isBotRunning}
                    className="w-full mt-1.5 bg-slate-800 border border-slate-700 p-2.5 rounded-xl text-sm font-mono"
                  />
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-800 flex gap-4">
              {!isBotRunning ? (
                <button
                  onClick={startBot}
                  className="flex-1 py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold uppercase tracking-wider rounded-xl transition shadow-lg shadow-emerald-950 text-sm"
                >
                  Start Automated Bot ▶
                </button>
              ) : (
                <button
                  onClick={() => stopBot('User clicked stop')}
                  className="flex-1 py-3.5 bg-rose-600 hover:bg-rose-500 text-white font-bold uppercase tracking-wider rounded-xl transition shadow-lg shadow-rose-950 text-sm"
                >
                  Stop Bot ⏹
                </button>
              )}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col h-96 lg:h-auto">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Execution Console</h2>
              <button
                onClick={() => setLogs([])}
                className="text-[10px] text-slate-500 hover:text-slate-300 transition"
              >
                Clear
              </button>
            </div>
            <div className="flex-1 bg-slate-950 p-3 rounded-xl border border-slate-800 font-mono text-xs overflow-y-auto space-y-1.5 scrollbar-thin">
              {logs.length === 0 ? (
                <span className="text-slate-600">Bot idle. Click Start to initialize execution.</span>
              ) : (
                logs.map((log, i) => (
                  <p
                    key={i}
                    className={`break-words ${
                      log.includes('[SUCCESS]')
                        ? 'text-emerald-400'
                        : log.includes('[ERROR]')
                        ? 'text-rose-400'
                        : log.includes('[TRADE]')
                        ? 'text-cyan-300'
                        : 'text-slate-400'
                    }`}
                  >
                    {log}
                  </p>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

