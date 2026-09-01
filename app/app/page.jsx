'use client';

import React, { useState, useEffect, useRef } from 'react';

const APP_ID = '1089'; // Public demo App ID (replace with your production App ID from developers.deriv.com)
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

export default function DBTradersClone() {
  // --- Navigation & View State ---
  const [activeTab, setActiveTab] = useState('bots'); // 'bots', 'analyzer', 'manual', 'community'

  // --- Auth & Account State ---
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [balance, setBalance] = useState(null);
  const [currency, setCurrency] = useState('USD');
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // --- Market & Analysis State ---
  const [symbol, setSymbol] = useState('R_100');
  const [lastTick, setLastTick] = useState(null);
  const [lastDigit, setLastDigit] = useState(null);
  const [digitHistory, setDigitHistory] = useState([]); // tracks last 100 digits for statistics
  const [digitStats, setDigitStats] = useState(Array(10).fill(10)); // percentage 0-9

  // --- Bot Strategy State ---
  const [strategy, setStrategy] = useState('DIGITDIFF'); // 'CALL', 'PUT', 'DIGITEVEN', 'DIGITODD', 'DIGITDIFF', 'DIGITMATCH', 'DIGITOVER', 'DIGITUNDER'
  const [baseStake, setBaseStake] = useState('1.00');
  const [currentStake, setCurrentStake] = useState('1.00');
  const [martingale, setMartingale] = useState('2.0');
  const [takeProfit, setTakeProfit] = useState('10.00');
  const [stopLoss, setStopLoss] = useState('25.00');
  const [duration, setDuration] = useState('1');
  const [predictionDigit, setPredictionDigit] = useState('5');
  const [botPreset, setBotPreset] = useState('custom');

  // --- Bot Execution Stats ---
  const [isBotRunning, setIsBotRunning] = useState(false);
  const [totalProfit, setTotalProfit] = useState(0);
  const [winCount, setWinCount] = useState(0);
  const [lossCount, setLossCount] = useState(0);
  const [logs, setLogs] = useState([]);

  // --- Refs for Async Loop State ---
  const wsRef = useRef(null);
  const botRunningRef = useRef(false);
  const totalProfitRef = useRef(0);
  const currentStakeRef = useRef(1.0);

  useEffect(() => { botRunningRef.current = isBotRunning; }, [isBotRunning]);
  useEffect(() => { totalProfitRef.current = totalProfit; }, [totalProfit]);
  useEffect(() => { currentStakeRef.current = parseFloat(currentStake) || 1.0; }, [currentStake]);

  const addLog = (msg, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [{ time: timestamp, text: msg, type }, ...prev.slice(0, 99)]);
  };

  // 1. Detect OAuth Redirect Params
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

  // 2. WebSocket Engine & Tick Analysis
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      addLog('Secure WebSocket connected to Deriv Financial Engine.', 'system');
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));

      if (token) {
        ws.send(JSON.stringify({ authorize: token }));
      }
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Auth Response
      if (data.msg_type === 'authorize') {
        if (data.error) {
          addLog(`Auth failed: ${data.error.message}`, 'error');
          setIsAuthorized(false);
        } else {
          setIsAuthorized(true);
          setAccountId(data.authorize.loginid);
          setIsAuthModalOpen(false);
          addLog(`Authorized account: ${data.authorize.loginid} (${data.authorize.email})`, 'success');
          ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        }
      }

      // Balance Feed
      if (data.msg_type === 'balance') {
        setBalance(data.balance.balance);
        setCurrency(data.balance.currency);
      }

      // Tick & Digit Analyzer Processing
      if (data.msg_type === 'tick' && data.tick) {
        const quote = data.tick.quote;
        setLastTick(quote);
        const strQuote = quote.toString();
        const digit = parseInt(strQuote.charAt(strQuote.length - 1), 10);
        if (!isNaN(digit)) {
          setLastDigit(digit);
          setDigitHistory((prev) => {
            const updated = [digit, ...prev.slice(0, 99)];
            const counts = Array(10).fill(0);
            updated.forEach((d) => counts[d]++);
            const total = updated.length || 1;
            setDigitStats(counts.map((c) => Math.round((c / total) * 100)));
            return updated;
          });
        }
      }

      // Proposal Handler
      if (data.msg_type === 'proposal') {
        if (data.error) {
          addLog(`Proposal error: ${data.error.message}`, 'error');
          if (botRunningRef.current) stopBot('Broker proposal error');
        } else if (data.proposal) {
          ws.send(JSON.stringify({
            buy: data.proposal.id,
            price: data.proposal.ask_price
          }));
        }
      }

      // Buy Execution Handler
      if (data.msg_type === 'buy') {
        if (data.error) {
          addLog(`Execution error: ${data.error.message}`, 'error');
          if (botRunningRef.current) stopBot('Trade purchase failed');
        } else {
          addLog(`Active Contract #${data.buy.contract_id} purchased. Stake: ${currentStakeRef.current} ${currency}`, 'trade');
          ws.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: data.buy.contract_id,
            subscribe: 1
          }));
        }
      }

      // Settlement Stream
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
      addLog('WebSocket connection closed.', 'error');
    };

    return () => {
      ws.close();
    };
  }, [symbol]);

  // Strategy Presets
  const applyPreset = (presetKey) => {
    setBotPreset(presetKey);
    if (presetKey === 'differs_safe') {
      setStrategy('DIGITDIFF');
      setBaseStake('1.00');
      setMartingale('11.0');
      setDuration('1');
      setPredictionDigit('0');
      setTakeProfit('10.00');
      setStopLoss('30.00');
    } else if (presetKey === 'even_odd_hunter') {
      setStrategy('DIGITEVEN');
      setBaseStake('1.00');
      setMartingale('2.1');
      setDuration('1');
      setTakeProfit('15.00');
      setStopLoss('25.00');
    } else if (presetKey === 'rise_fall_trend') {
      setStrategy('CALL');
      setBaseStake('2.00');
      setMartingale('2.0');
      setDuration('5');
      setTakeProfit('20.00');
      setStopLoss('40.00');
    }
  };

  // Trade Outcome & Risk Automation
  const handleTradeResult = (isWin, profit) => {
    const newNetProfit = Number((totalProfitRef.current + profit).toFixed(2));
    setTotalProfit(newNetProfit);

    if (isWin) {
      setWinCount((w) => w + 1);
      addLog(`WIN: +$${profit.toFixed(2)} | Net Session: ${newNetProfit >= 0 ? '+' : ''}$${newNetProfit.toFixed(2)}`, 'success');
      const base = parseFloat(baseStake) || 1.0;
      setCurrentStake(base.toFixed(2));
    } else {
      setLossCount((l) => l + 1);
      addLog(`LOSS: -$${Math.abs(profit).toFixed(2)} | Net Session: ${newNetProfit >= 0 ? '+' : ''}$${newNetProfit.toFixed(2)}`, 'error');
      const mMultiplier = parseFloat(martingale) || 1.0;
      const nextStake = (currentStakeRef.current * mMultiplier).toFixed(2);
      setCurrentStake(nextStake);
    }

    const tp = parseFloat(takeProfit);
    const sl = parseFloat(stopLoss);

    if (newNetProfit >= tp) {
      stopBot(`Target Take-Profit Reached (+$${newNetProfit.toFixed(2)})!`);
      return;
    }

    if (newNetProfit <= -sl) {
      stopBot(`Stop-Loss Limit Reached (-$${Math.abs(newNetProfit).toFixed(2)})!`);
      return;
    }

    if (botRunningRef.current) {
      setTimeout(() => {
        if (botRunningRef.current) {
          triggerTrade(strategy);
        }
      }, 750);
    }
  };

  // Execute Trade Order
  const triggerTrade = (chosenStrategy = strategy, customDuration = duration) => {
    if (!wsRef.current || !isAuthorized) {
      setIsAuthModalOpen(true);
      return;
    }

    const payload = {
      proposal: 1,
      amount: parseFloat(currentStakeRef.current),
      basis: 'stake',
      currency: currency,
      symbol: symbol,
      contract_type: chosenStrategy,
      duration: parseInt(customDuration, 10),
      duration_unit: 't'
    };

    if (['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(chosenStrategy)) {
      payload.barrier = predictionDigit.toString();
    }

    addLog(`Submitting ${chosenStrategy} proposal [Stake: $${currentStakeRef.current}]...`, 'trade');
    wsRef.current.send(JSON.stringify(payload));
  };

  // Bot Controller
  const startBot = () => {
    if (!isAuthorized) {
      setIsAuthModalOpen(true);
      return;
    }
    setIsBotRunning(true);
    setCurrentStake(baseStake);
    addLog(`Automated Bot Initiated with strategy: ${strategy}`, 'system');
    setTimeout(() => {
      triggerTrade(strategy);
    }, 300);
  };

  const stopBot = (reason = 'Manual stop') => {
    setIsBotRunning(false);
    addLog(`Bot Execution Stopped: ${reason}`, 'system');
  };

  const handleOAuthLogin = () => {
    const redirectUrl = window.location.origin;
    window.location.href = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}&l=en&brand=deriv&redirect_url=${encodeURIComponent(redirectUrl)}`;
  };

  const handleManualAuth = () => {
    if (!token || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ authorize: token }));
  };

  return (
    <div className="min-h-screen bg-[#0b0e14] text-slate-100 font-sans antialiased selection:bg-emerald-500 selection:text-black">

      {/* Top Real-Time Broker Bar */}
      <div className="bg-[#121722] border-b border-slate-800/80 px-4 py-2 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
            <span className="font-medium text-slate-300">{isConnected ? 'Broker Server Live (Deriv API)' : 'Gateway Offline'}</span>
          </div>
          <span className="hidden sm:inline text-slate-600">|</span>
          <div className="hidden sm:flex items-center gap-2">
            <span>Selected Market:</span>
            <span className="font-mono font-bold text-amber-400">{symbol}</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-mono">
            <span className="text-slate-500">Live Tick:</span>
            <span className="text-emerald-400 font-bold">{lastTick !== null ? lastTick : 'Streaming...'}</span>
          </div>
          <span className="text-slate-600">|</span>
          <div className="flex items-center gap-2 font-mono">
            <span className="text-slate-500">L-Digit:</span>
            <span className="bg-slate-800 px-2 py-0.5 rounded text-cyan-400 font-bold">{lastDigit !== null ? lastDigit : '-'}</span>
          </div>
        </div>
      </div>

      {/* Main Header / Navigation */}
      <header className="border-b border-slate-800 bg-[#0f141e]/90 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3 cursor-pointer" onClick={() => setActiveTab('bots')}>
              <div className="h-10 w-10 bg-gradient-to-tr from-emerald-600 to-teal-400 rounded-xl flex items-center justify-center font-black text-black text-xl shadow-lg shadow-emerald-950/50">
                DB
              </div>
              <div>
                <span className="text-lg font-black tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                  BINARY<span className="text-emerald-400">SPOT</span>
                </span>
                <span className="hidden sm:block text-[10px] uppercase font-bold tracking-widest text-emerald-500/80 -mt-1">
                  Pro Trading Suite
                </span>
              </div>
            </div>

            {/* Navigation Tabs */}
            <nav className="hidden md:flex items-center gap-1 bg-slate-900/80 p-1 rounded-xl border border-slate-800">
              <button
                onClick={() => setActiveTab('bots')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center gap-2 ${
                  activeTab === 'bots' ? 'bg-emerald-500 text-black shadow-md' : 'text-slate-400 hover:text-white'
                }`}
              >
                🤖 Bot Studio
              </button>
              <button
                onClick={() => setActiveTab('analyzer')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center gap-2 ${
                  activeTab === 'analyzer' ? 'bg-emerald-500 text-black shadow-md' : 'text-slate-400 hover:text-white'
                }`}
              >
                📊 Digit Analyzer
              </button>
              <button
                onClick={() => setActiveTab('manual')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center gap-2 ${
                  activeTab === 'manual' ? 'bg-emerald-500 text-black shadow-md' : 'text-slate-400 hover:text-white'
                }`}
              >
                📈 Manual Trader
              </button>
              <button
                onClick={() => setActiveTab('community')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition flex items-center gap-2 ${
                  activeTab === 'community' ? 'bg-emerald-500 text-black shadow-md' : 'text-slate-400 hover:text-white'
                }`}
              >
                💎 Strategies & VIP
              </button>
            </nav>
          </div>

          {/* Account Widget */}
          <div className="flex items-center gap-3">
            {isAuthorized ? (
              <div className="flex items-center gap-3 bg-[#161c28] border border-slate-700/80 px-3.5 py-1.5 rounded-xl shadow-inner">
                <div className="text-right">
                  <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">{accountId}</p>
                  <p className="text-sm font-black text-emerald-400 font-mono">
                    {balance !== null ? `$${parseFloat(balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '...'}
                  </p>
                </div>
                <button
                  onClick={() => setIsAuthorized(false)}
                  className="text-[10px] text-slate-500 hover:text-rose-400 transition ml-1"
                  title="Disconnect"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={() => setIsAuthModalOpen(true)}
                className="px-4 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-lg shadow-emerald-950/40 transition transform active:scale-95"
              >
                Connect Account
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mobile Tab Bar */}
      <div className="md:hidden flex border-b border-slate-800 bg-[#0f141e] px-2 py-2 gap-1 overflow-x-auto">
        {['bots', 'analyzer', 'manual', 'community'].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 px-3 text-[11px] font-bold rounded-lg whitespace-nowrap capitalize transition ${
              activeTab === tab ? 'bg-emerald-500 text-black' : 'text-slate-400 bg-slate-900/50'
            }`}
          >
            {tab === 'bots' ? '🤖 Bots' : tab === 'analyzer' ? '📊 Analyzer' : tab === 'manual' ? '📈 Manual' : '💎 VIP'}
          </button>
        ))}
      </div>

      {/* Hero Welcome Banner */}
      <div className="relative overflow-hidden border-b border-slate-800/80 bg-gradient-to-b from-[#121824] to-[#0b0e14] py-8 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="space-y-2 text-center md:text-left">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
              Automated Algorithmic Execution System
            </div>
            <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-white">
              Institutional-Grade Deriv Trading Tools
            </h2>
            <p className="text-sm text-slate-400 max-w-xl">
              Execute high-frequency digit algorithms, Martingale strategies, and live mathematical analysis with zero-latency WebSocket connection.
            </p>
          </div>

          <div className="flex items-center gap-4 bg-slate-900/80 border border-slate-800 p-4 rounded-2xl shadow-xl">
            <div className="text-center px-3 border-r border-slate-800">
              <p className="text-xs text-slate-400 uppercase font-medium">Session P/L</p>
              <p className={`text-xl font-mono font-black ${totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {totalProfit >= 0 ? `+$${totalProfit.toFixed(2)}` : `-$${Math.abs(totalProfit).toFixed(2)}`}
              </p>
            </div>
            <div className="text-center px-3">
              <p className="text-xs text-slate-400 uppercase font-medium">Win Rate</p>
              <p className="text-xl font-mono font-black text-slate-200">
                {winCount + lossCount === 0 ? '0%' : `${Math.round((winCount / (winCount + lossCount)) * 100)}%`}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* TAB 1: BOT STUDIO */}
        {activeTab === 'bots' && (
          <div className="space-y-6">

            {/* Strategy Preset Cards */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Quick Load Verified Strategies</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div
                  onClick={() => applyPreset('differs_safe')}
                  className={`cursor-pointer p-4 rounded-2xl border transition relative overflow-hidden ${
                    botPreset === 'differs_safe'
                      ? 'bg-emerald-950/20 border-emerald-500 shadow-lg shadow-emerald-950/50'
                      : 'bg-[#121722] border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <span className="text-xs font-black uppercase text-emerald-400 tracking-wider">High Probability</span>
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-300 font-mono px-2 py-0.5 rounded">~90% Win</span>
                  </div>
                  <h4 className="text-base font-bold text-white mt-1">Digit Differs Sentinel</h4>
                  <p className="text-xs text-slate-400 mt-1">Predicts last digit will not match prediction. Rapid micro-compounding.</p>
                </div>

                <div
                  onClick={() => applyPreset('even_odd_hunter')}
                  className={`cursor-pointer p-4 rounded-2xl border transition relative overflow-hidden ${
                    botPreset === 'even_odd_hunter'
                      ? 'bg-cyan-950/20 border-cyan-500 shadow-lg shadow-cyan-950/50'
                      : 'bg-[#121722] border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <span className="text-xs font-black uppercase text-cyan-400 tracking-wider">Parity Bot</span>
                    <span className="text-[10px] bg-cyan-500/20 text-cyan-300 font-mono px-2 py-0.5 rounded">1:1 Payout</span>
                  </div>
                  <h4 className="text-base font-bold text-white mt-1">Digit Even/Odd Hunter</h4>
                  <p className="text-xs text-slate-400 mt-1">Alternating sequence analyzer targeting high-volume digit parity runs.</p>
                </div>

                <div
                  onClick={() => applyPreset('rise_fall_trend')}
                  className={`cursor-pointer p-4 rounded-2xl border transition relative overflow-hidden ${
                    botPreset === 'rise_fall_trend'
                      ? 'bg-amber-950/20 border-amber-500 shadow-lg shadow-amber-950/50'
                      : 'bg-[#121722] border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <span className="text-xs font-black uppercase text-amber-400 tracking-wider">Trend Momentum</span>
                    <span className="text-[10px] bg-amber-500/20 text-amber-300 font-mono px-2 py-0.5 rounded">Multi-Tick</span>
                  </div>
                  <h4 className="text-base font-bold text-white mt-1">Rise / Fall Momentum</h4>
                  <p className="text-xs text-slate-400 mt-1">5-Tick momentum contract execution for volatile market conditions.</p>
                </div>
              </div>
            </div>

            {/* Bot Controls & Live Console */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

              {/* Bot Parameter Form */}
              <div className="lg:col-span-2 bg-[#121722] border border-slate-800 p-6 rounded-2xl space-y-6 shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                  <div>
                    <h3 className="text-base font-bold text-white">Bot Strategy Configurator</h3>
                    <p className="text-xs text-slate-400">Configure contract types, risk management, and Martingale rules.</p>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase font-mono ${
                    isBotRunning ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 animate-pulse' : 'bg-slate-800 text-slate-400'
                  }`}>
                    {isBotRunning ? 'Active Trading' : 'Idle'}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-400">Market (Synthetic Index)</label>
                    <select
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value)}
                      disabled={isBotRunning}
                      className="w-full mt-1.5 bg-[#182030] border border-slate-700 p-3 rounded-xl text-sm focus:outline-none focus:border-emerald-500"
                    >
                      <option value="R_100">Volatility 100 Index</option>
                      <option value="R_50">Volatility 50 Index</option>
                      <option value="R_25">Volatility 25 Index</option>
                      <option value="R_10">Volatility 10 Index</option>
                      <option value="1HZ100V">Volatility 100 (1s) Index</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400">Contract Execution Type</label>
                    <select
                      value={strategy}
                      onChange={(e) => {
                        setStrategy(e.target.value);
                        setBotPreset('custom');
                      }}
                      disabled={isBotRunning}
                      className="w-full mt-1.5 bg-[#182030] border border-slate-700 p-3 rounded-xl text-sm focus:outline-none focus:border-emerald-500"
                    >
                      <option value="DIGITDIFF">Digit Differs (Safe micro-gains)</option>
                      <option value="DIGITMATCH">Digit Matches (High 800%+ payout)</option>
                      <option value="DIGITEVEN">Digit Even</option>
                      <option value="DIGITODD">Digit Odd</option>
                      <option value="DIGITOVER">Digit Over</option>
                      <option value="DIGITUNDER">Digit Under</option>
                      <option value="CALL">Rise / Higher ▲</option>
                      <option value="PUT">Fall / Lower ▼</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400">Base Initial Stake ($)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={baseStake}
                      onChange={(e) => setBaseStake(e.target.value)}
                      disabled={isBotRunning}
                      className="w-full mt-1.5 bg-[#182030] border border-slate-700 p-3 rounded-xl text-sm font-mono focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400">Martingale Factor (on Loss)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={martingale}
                      onChange={(e) => setMartingale(e.target.value)}
                      disabled={isBotRunning}
                      className="w-full mt-1.5 bg-[#182030] border border-slate-700 p-3 rounded-xl text-sm font-mono focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-emerald-400">Take Profit Target ($)</label>
                    <input
                      type="number"
                      value={takeProfit}
                      onChange={(e) => setTakeProfit(e.target.value)}
                      disabled={isBotRunning}
                      className="w-full mt-1.5 bg-[#182030] border border-emerald-900/60 p-3 rounded-xl text-sm font-mono text-emerald-300 focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-rose-400">Stop Loss Maximum ($)</label>
                    <input
                      type="number"
                      value={stopLoss}
                      onChange={(e) => setStopLoss(e.target.value)}
                      disabled={isBotRunning}
                      className="w-full mt-1.5 bg-[#182030] border border-rose-900/60 p-3 rounded-xl text-sm font-mono text-rose-300 focus:outline-none focus:border-rose-500"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400">Duration (Ticks: 1 - 10)</label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      disabled={isBotRunning}
                      className="w-full mt-1.5 bg-[#182030] border border-slate-700 p-3 rounded-xl text-sm font-mono focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  {['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(strategy) && (
                    <div>
                      <label className="text-xs font-semibold text-cyan-400">Prediction Digit Barrier (0 - 9)</label>
                      <input
                        type="number"
                        min="0"
                        max="9"
                        value={predictionDigit}
                        onChange={(e) => setPredictionDigit(e.target.value)}
                        disabled={isBotRunning}
                        className="w-full mt-1.5 bg-[#182030] border border-cyan-800/60 p-3 rounded-xl text-sm font-mono text-cyan-300 focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                  )}
                </div>

                {/* Primary Action Button */}
                <div className="pt-2">
                  {!isBotRunning ? (
                    <button
                      onClick={startBot}
                      className="w-full py-4 bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-sm uppercase tracking-wider rounded-xl transition shadow-xl shadow-emerald-950/50 transform active:scale-[0.99]"
                    >
                      ▶ Run Automated Bot Engine
                    </button>
                  ) : (
                    <button
                      onClick={() => stopBot('User clicked stop')}
                      className="w-full py-4 bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-black text-sm uppercase tracking-wider rounded-xl transition shadow-xl shadow-rose-950/50 transform active:scale-[0.99]"
                    >
                      ⏹ Terminate Bot Execution
                    </button>
                  )}
                </div>
              </div>

              {/* Execution Feed Console */}
              <div className="bg-[#121722] border border-slate-800 p-5 rounded-2xl flex flex-col h-[520px] shadow-xl">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-cyan-400" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Live Execution Log</h3>
                  </div>
                  <button
                    onClick={() => setLogs([])}
                    className="text-[10px] text-slate-500 hover:text-slate-300 transition"
                  >
                    Clear Feed
                  </button>
                </div>

                <div className="flex-1 bg-[#090c12] p-3 rounded-xl border border-slate-800/80 font-mono text-xs overflow-y-auto space-y-2">
                  {logs.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-slate-600 text-center text-xs">
                      Bot is in standby mode.<br />Select a strategy and press Run.
                    </div>
                  ) : (
                    logs.map((log, i) => (
                      <div
                        key={i}
                        className={`p-2 rounded border leading-relaxed ${
                          log.type === 'success'
                            ? 'bg-emerald-950/30 border-emerald-900/50 text-emerald-300'
                            : log.type === 'error'
                            ? 'bg-rose-950/30 border-rose-900/50 text-rose-300'
                            : log.type === 'trade'
                            ? 'bg-cyan-950/30 border-cyan-900/50 text-cyan-200'
                            : 'bg-slate-900/50 border-slate-800 text-slate-400'
                        }`}
                      >
                        <span className="text-[10px] opacity-60 mr-1.5">[{log.time}]</span>
                        <span>{log.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>
          </div>
        )}

        {/* TAB 2: DIGIT ANALYZER */}
        {activeTab === 'analyzer' && (
          <div className="space-y-6">
            <div className="bg-[#121722] border border-slate-800 p-6 rounded-2xl shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-6">
                <div>
                  <h3 className="text-lg font-bold text-white">Last 100 Ticks Digit Frequency Analyzer</h3>
                  <p className="text-xs text-slate-400">Live statistical breakdown of exit digits on {symbol}.</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Active Asset:</span>
                  <select
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    className="bg-[#182030] border border-slate-700 px-3 py-1.5 rounded-lg text-xs"
                  >
                    <option value="R_100">Volatility 100 Index</option>
                    <option value="R_50">Volatility 50 Index</option>
                    <option value="1HZ100V">Volatility 100 (1s) Index</option>
                  </select>
                </div>
              </div>

              {/* Bar Frequency Distribution */}
              <div className="grid grid-cols-5 sm:grid-cols-10 gap-3">
                {digitStats.map((pct, digit) => (
                  <div key={digit} className="flex flex-col items-center bg-[#090c12] border border-slate-800 p-3 rounded-xl">
                    <span className="text-sm font-bold text-slate-200 mb-1">{digit}</span>
                    <div className="h-36 w-full bg-slate-800/40 rounded-lg flex items-end justify-center p-1">
                      <div
                        style={{ height: `${Math.min(pct * 3, 100)}%` }}
                        className={`w-full rounded transition-all duration-500 ${
                          pct >= 15 ? 'bg-emerald-400 shadow-lg shadow-emerald-500/50' : pct <= 6 ? 'bg-rose-500' : 'bg-cyan-500'
                        }`}
                      />
                    </div>
                    <span className="mt-2 font-mono text-xs font-bold text-slate-300">{pct}%</span>
                  </div>
                ))}
              </div>

              {/* Recent History Ribbon */}
              <div className="mt-6 pt-4 border-t border-slate-800">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-2">
                  Last 25 Consecutive Digits
                </span>
                <div className="flex flex-wrap gap-2">
                  {digitHistory.slice(0, 25).map((d, i) => (
                    <span
                      key={i}
                      className={`h-9 w-9 rounded-xl flex items-center justify-center font-mono font-bold text-sm ${
                        i === 0
                          ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/50 scale-105'
                          : d % 2 === 0
                          ? 'bg-slate-800 border border-slate-700 text-cyan-400'
                          : 'bg-slate-800 border border-slate-700 text-amber-400'
                      }`}
                    >
                      {d}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: MANUAL TRADING */}
        {activeTab === 'manual' && (
          <div className="max-w-2xl mx-auto bg-[#121722] border border-slate-800 p-6 rounded-2xl shadow-xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-white">Manual Quick Trade Terminal</h3>
              <p className="text-xs text-slate-400">Execute instantaneous Rise/Fall contracts directly onto the broker feed.</p>
            </div>

            <div className="bg-[#090c12] p-6 rounded-xl border border-slate-800 text-center space-y-2">
              <span className="text-xs text-slate-400 uppercase">Live Index Quote</span>
              <p className="text-4xl font-mono font-black text-amber-400">{lastTick ?? '0.00'}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-400">Order Stake ($)</label>
                <input
                  type="number"
                  value={baseStake}
                  onChange={(e) => setBaseStake(e.target.value)}
                  className="w-full mt-1 bg-[#182030] border border-slate-700 p-3 rounded-xl text-sm font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400">Ticks Duration</label>
                <input
                  type="number"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  className="w-full mt-1 bg-[#182030] border border-slate-700 p-3 rounded-xl text-sm font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-2">
              <button
                onClick={() => triggerTrade('CALL', duration)}
                className="py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-sm uppercase tracking-wider shadow-lg shadow-emerald-950 transition transform active:scale-95"
              >
                ▲ Higher / Rise
              </button>
              <button
                onClick={() => triggerTrade('PUT', duration)}
                className="py-4 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-sm uppercase tracking-wider shadow-lg shadow-rose-950 transition transform active:scale-95"
              >
                ▼ Lower / Fall
              </button>
            </div>
          </div>
        )}

        {/* TAB 4: COMMUNITY & VIP */}
        {activeTab === 'community' && (
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="bg-gradient-to-r from-emerald-950/40 via-slate-900 to-cyan-950/40 border border-emerald-500/30 p-8 rounded-3xl text-center space-y-4 shadow-2xl">
              <span className="bg-emerald-500/10 text-emerald-400 text-xs font-bold px-3 py-1 rounded-full uppercase border border-emerald-500/20">
                VIP Traders Club
              </span>
              <h3 className="text-2xl sm:text-3xl font-black text-white">Join the Automated Trading Community</h3>
              <p className="text-sm text-slate-400 max-w-lg mx-auto">
                Get access to exclusive custom XML bots, digit risk-calculators, and daily VIP strategy calls.
              </p>
              <div className="pt-2">
                <a
                  href="https://t.me"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 px-6 py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl transition shadow-lg shadow-cyan-950"
                >
                  Join Official Telegram Channel ↗
                </a>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* Account Authentication Modal */}
      {isAuthModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121722] border border-slate-700 max-w-md w-full p-6 rounded-3xl shadow-2xl space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-white">Connect Deriv Trading Account</h3>
              <button onClick={() => setIsAuthModalOpen(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="space-y-4">
              <button
                onClick={handleOAuthLogin}
                className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs uppercase tracking-wider rounded-xl transition"
              >
                Log In with Deriv (OAuth)
              </button>

              <div className="flex items-center gap-3">
                <hr className="flex-1 border-slate-800" />
                <span className="text-[10px] uppercase font-bold text-slate-500">Or use API token</span>
                <hr className="flex-1 border-slate-800" />
              </div>

              <div className="space-y-2">
                <input
                  type="password"
                  placeholder="Paste your Deriv API Token (Read + Trade)"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full bg-[#182030] border border-slate-700 p-3 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
                />
                <button
                  onClick={handleManualAuth}
                  className="w-full py-3 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-xs font-bold rounded-xl transition"
                >
                  Authorize Token
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
