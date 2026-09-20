"use client";

import React, { useState, useEffect } from 'react';
import { cn } from "@/lib/utils";
import { Button } from '@/components/ui/button';
import { Briefcase, TrendingUp, ShieldAlert, BarChart3, Plus, RefreshCw, AlertTriangle, ArrowUpRight, ArrowDownRight, DollarSign } from 'lucide-react';

type Tab = 'portfolio' | 'reports' | 'risk' | 'forecast';

interface PortfolioItem {
  id: string;
  name?: string;
  asset_type?: string;
  ticker?: string;
  quantity?: number | string;
  buy_price?: number | string;
  current_price?: number | string;
}

interface PortfolioAnalysis {
  risk_score?: number | string;
  analysis?: string;
  recommendations?: string[];
  error?: string;
}

interface RiskResult {
  risk_level?: string;
  score?: number | string;
  mitigations?: string[];
  error?: string;
}

interface ForecastMonth {
  month?: string | number;
  revenue?: number | string;
  expenses?: number | string;
  profit?: number | string;
}

export default function FinanceHub() {
  const [activeTab, setActiveTab] = useState<Tab>('portfolio');
  
  // State for portfolio
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  
  const [newItem, setNewItem] = useState({ name: '', asset_type: 'Stock', ticker: '', quantity: 0, buy_price: 0, current_price: 0, notes: '' });
  
  const [portfolioAnalysis, setPortfolioAnalysis] = useState<PortfolioAnalysis | null>(null);
  const [analyzingPortfolio, setAnalyzingPortfolio] = useState(false);

  // State for reports
  const [reportForm, setReportForm] = useState({ period: 'Q1 2024', revenue: '', expenses: '', notes: '' });
  const [reportResult, setReportResult] = useState<string>('');
  const [generatingReport, setGeneratingReport] = useState(false);

  // State for risk
  const [riskForm, setRiskForm] = useState({ description: '', market_context: '' });
  const [riskResult, setRiskResult] = useState<RiskResult | null>(null);
  const [assessingRisk, setAssessingRisk] = useState(false);

  // State for forecast
  const [forecastForm, setForecastForm] = useState({ monthly_revenue: '', fixed_costs: '', variable_costs: '', growth_rate: '' });
  const [forecastResult, setForecastResult] = useState<ForecastMonth[]>([]);
  const [generatingForecast, setGeneratingForecast] = useState(false);

  useEffect(() => {
    if (activeTab === 'portfolio') {
      fetchPortfolio();
    }
  }, [activeTab]);

  const fetchPortfolio = async () => {
    setLoadingPortfolio(true);
    try {
      const res = await fetch('/api/domains/finance?action=portfolio');
      const data = await res.json();
      if (Array.isArray(data.items)) {
        setPortfolio(data.items);
      }
    } catch (e) {
      console.error(e);
    }
    setLoadingPortfolio(false);
  };

  const addPortfolioItem = async () => {
    try {
      const res = await fetch('/api/domains/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add_portfolio_item', ...newItem, quantity: Number(newItem.quantity), buy_price: Number(newItem.buy_price), current_price: Number(newItem.current_price) })
      });
      if (res.ok) {
        fetchPortfolio();
        setNewItem({ name: '', asset_type: 'Stock', ticker: '', quantity: 0, buy_price: 0, current_price: 0, notes: '' });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const analyzePortfolio = async () => {
    setAnalyzingPortfolio(true);
    try {
      const res = await fetch('/api/domains/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze_portfolio' })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error) {
        setPortfolioAnalysis(data);
      } else {
        setPortfolioAnalysis(null);
        alert(data?.error ?? "Portfolio analysis failed");
      }
    } catch (e) {
      console.error(e);
    }
    setAnalyzingPortfolio(false);
  };

  const generateReport = async () => {
    setGeneratingReport(true);
    try {
      const res = await fetch('/api/domains/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate_financial_report', ...reportForm, revenue: Number(reportForm.revenue), expenses: Number(reportForm.expenses) })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error && typeof data?.report === "string") {
        setReportResult(data.report);
      } else {
        setReportResult('');
        alert(data?.error ?? "Report generation failed");
      }
    } catch (e) {
      console.error(e);
    }
    setGeneratingReport(false);
  };

  const assessRisk = async () => {
    setAssessingRisk(true);
    try {
      const res = await fetch('/api/domains/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'risk_assessment', ...riskForm })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error) {
        setRiskResult(data);
      } else {
        setRiskResult(null);
        alert(data?.error ?? "Risk assessment failed");
      }
    } catch (e) {
      console.error(e);
    }
    setAssessingRisk(false);
  };

  const generateForecast = async () => {
    setGeneratingForecast(true);
    try {
      const res = await fetch('/api/domains/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'budget_forecast', 
          monthly_revenue: Number(forecastForm.monthly_revenue),
          fixed_costs: Number(forecastForm.fixed_costs),
          variable_costs: Number(forecastForm.variable_costs),
          growth_rate: Number(forecastForm.growth_rate)
        })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error) {
        setForecastResult(Array.isArray(data?.forecast) ? data.forecast : []);
      } else {
        setForecastResult([]);
        alert(data?.error ?? "Forecast generation failed");
      }
    } catch (e) {
      console.error(e);
    }
    setGeneratingForecast(false);
  };

  const totalPortfolioValue = portfolio.reduce((acc, item) => acc + ((Number(item.quantity) || 0) * (Number(item.current_price) || 0)), 0);
  const totalCostBasis = portfolio.reduce((acc, item) => acc + ((Number(item.quantity) || 0) * (Number(item.buy_price) || 0)), 0);
  const totalProfitLoss = totalPortfolioValue - totalCostBasis;
  const isPositive = totalProfitLoss >= 0;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center space-x-3 mb-8">
        <div className="p-3 bg-emerald-500/20 text-emerald-500 rounded-xl">
          <DollarSign className="w-8 h-8" />
        </div>
        <h1 className="text-3xl font-bold text-foreground">Finance Hub</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground mb-1">Total Portfolio Value</p>
          <p className="text-3xl font-bold">{"$"}{totalPortfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground mb-1">Total P&L</p>
          <div className="flex items-center space-x-2">
            <p className={cn("text-3xl font-bold", isPositive ? 'text-emerald-500' : 'text-red-500')}>
              {isPositive ? '+' : '-'}{"$"}{Math.abs(totalProfitLoss).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            {isPositive ? <ArrowUpRight className="w-6 h-6 text-emerald-500" /> : <ArrowDownRight className="w-6 h-6 text-red-500" />}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground mb-1">Assets Count</p>
          <p className="text-3xl font-bold">{portfolio.length}</p>
        </div>
      </div>

      <div className="flex space-x-2 border-b border-border mb-6 overflow-x-auto whitespace-nowrap">
        <button
          onClick={() => setActiveTab('portfolio')}
          className={cn("px-4 py-2 font-medium text-sm transition-colors relative", activeTab === 'portfolio' ? 'text-emerald-500' : 'text-muted-foreground hover:text-foreground')}
        >
          <div className="flex items-center space-x-2">
            <Briefcase className="w-4 h-4" />
            <span>Portfolio Tracker</span>
          </div>
          {activeTab === 'portfolio' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-t-full" />}
        </button>
        <button
          onClick={() => setActiveTab('reports')}
          className={cn("px-4 py-2 font-medium text-sm transition-colors relative", activeTab === 'reports' ? 'text-emerald-500' : 'text-muted-foreground hover:text-foreground')}
        >
          <div className="flex items-center space-x-2">
            <TrendingUp className="w-4 h-4" />
            <span>Financial Reports</span>
          </div>
          {activeTab === 'reports' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-t-full" />}
        </button>
        <button
          onClick={() => setActiveTab('risk')}
          className={cn("px-4 py-2 font-medium text-sm transition-colors relative", activeTab === 'risk' ? 'text-emerald-500' : 'text-muted-foreground hover:text-foreground')}
        >
          <div className="flex items-center space-x-2">
            <ShieldAlert className="w-4 h-4" />
            <span>Risk Dashboard</span>
          </div>
          {activeTab === 'risk' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-t-full" />}
        </button>
        <button
          onClick={() => setActiveTab('forecast')}
          className={cn("px-4 py-2 font-medium text-sm transition-colors relative", activeTab === 'forecast' ? 'text-emerald-500' : 'text-muted-foreground hover:text-foreground')}
        >
          <div className="flex items-center space-x-2">
            <BarChart3 className="w-4 h-4" />
            <span>Budget Forecast</span>
          </div>
          {activeTab === 'forecast' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-t-full" />}
        </button>
      </div>

      {activeTab === 'portfolio' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="font-semibold mb-4 text-lg">Add New Asset</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <input type="text" placeholder="Name" value={newItem.name} onChange={e => setNewItem({...newItem, name: e.target.value})} className="bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              <input type="text" placeholder="Asset Type" value={newItem.asset_type} onChange={e => setNewItem({...newItem, asset_type: e.target.value})} className="bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              <input type="text" placeholder="Ticker (Optional)" value={newItem.ticker} onChange={e => setNewItem({...newItem, ticker: e.target.value})} className="bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              <input type="number" placeholder="Quantity" value={newItem.quantity || ''} onChange={e => setNewItem({...newItem, quantity: Number(e.target.value)})} className="bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              <input type="number" placeholder="Buy Price" value={newItem.buy_price || ''} onChange={e => setNewItem({...newItem, buy_price: Number(e.target.value)})} className="bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              <input type="number" placeholder="Current Price" value={newItem.current_price || ''} onChange={e => setNewItem({...newItem, current_price: Number(e.target.value)})} className="bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              <input type="text" placeholder="Notes (Optional)" value={newItem.notes} onChange={e => setNewItem({...newItem, notes: e.target.value})} className="bg-background border border-border rounded-lg px-3 py-2 text-sm col-span-2" />
            </div>
            <Button onClick={addPortfolioItem} className="bg-emerald-600 hover:bg-emerald-700">
              <Plus className="w-4 h-4 mr-2" /> Add Asset
            </Button>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 overflow-x-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-lg">Your Portfolio</h3>
              <Button onClick={analyzePortfolio} disabled={analyzingPortfolio || portfolio.length === 0} variant="outline" className="border-emerald-500 text-emerald-500 hover:bg-emerald-500/10">
                {analyzingPortfolio ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <BarChart3 className="w-4 h-4 mr-2" />}
                AI Analysis
              </Button>
            </div>
            
            {portfolioAnalysis && (
              <div className="mb-6 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <div className="flex items-center space-x-3 mb-3">
                  <div className="w-12 h-12 rounded-full border-4 border-emerald-500 flex items-center justify-center font-bold text-lg text-emerald-500">
                    {portfolioAnalysis.risk_score}
                  </div>
                  <div>
                    <h4 className="font-bold text-emerald-500">Risk Score</h4>
                    <p className="text-sm text-muted-foreground">Based on your current allocation</p>
                  </div>
                </div>
                <p className="text-sm mb-4 leading-relaxed">{portfolioAnalysis.analysis}</p>
                <div className="space-y-1">
                  <h4 className="font-semibold text-sm">Recommendations:</h4>
                  <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                    {portfolioAnalysis.recommendations?.map((r: string, i: number) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {portfolio.length > 0 ? (
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 rounded-tl-lg">Asset</th>
                    <th className="px-4 py-3">Ticker</th>
                    <th className="px-4 py-3">Qty</th>
                    <th className="px-4 py-3">Buy Price</th>
                    <th className="px-4 py-3">Current Price</th>
                    <th className="px-4 py-3">Value</th>
                    <th className="px-4 py-3 rounded-tr-lg">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.map((item) => {
                    const cur = Number(item.current_price) || 0;
                    const buy = Number(item.buy_price) || 0;
                    const qty = Number(item.quantity) || 0;
                    const pl = (cur - buy) * qty;
                    const plPercent = buy !== 0 ? ((cur - buy) / buy) * 100 : 0;
                    const isPlPos = pl >= 0;
                    return (
                      <tr key={item.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-medium">
                          {item.name}
                          <span className="block text-xs text-muted-foreground">{item.asset_type}</span>
                        </td>
                        <td className="px-4 py-3">{item.ticker || '-'}</td>
                        <td className="px-4 py-3">{item.quantity}</td>
                        <td className="px-4 py-3">{"$"}{Number(item.buy_price).toFixed(2)}</td>
                        <td className="px-4 py-3">{"$"}{Number(item.current_price).toFixed(2)}</td>
                        <td className="px-4 py-3 font-medium">{"$"}{(Number(item.quantity) * Number(item.current_price)).toFixed(2)}</td>
                        <td className={cn("px-4 py-3 font-medium", isPlPos ? 'text-emerald-500' : 'text-red-500')}>
                          {isPlPos ? '+' : ''}{"$"}{pl.toFixed(2)} ({isPlPos ? '+' : ''}{plPercent.toFixed(2)}%)
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : loadingPortfolio ? (
              <p className="text-center text-muted-foreground py-8">Loading portfolio…</p>
            ) : (
              <p className="text-center text-muted-foreground py-8">No assets in your portfolio yet.</p>
            )}
          </div>
        </div>
      )}

      {activeTab === 'reports' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="rounded-xl border border-border bg-card p-5 lg:col-span-1 h-fit">
            <h3 className="font-semibold mb-4">Generate Report</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Period</label>
                <input type="text" value={reportForm.period} onChange={e => setReportForm({...reportForm, period: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" placeholder="e.g. Q3 2024" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Revenue ($)</label>
                <input type="number" value={reportForm.revenue} onChange={e => setReportForm({...reportForm, revenue: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Expenses ($)</label>
                <input type="number" value={reportForm.expenses} onChange={e => setReportForm({...reportForm, expenses: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Notes (Optional)</label>
                <textarea value={reportForm.notes} onChange={e => setReportForm({...reportForm, notes: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm h-24" placeholder="Significant events..." />
              </div>
              <Button onClick={generateReport} disabled={generatingReport} className="w-full bg-emerald-600 hover:bg-emerald-700">
                {generatingReport ? 'Generating...' : 'Generate AI Report'}
              </Button>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2 min-h-[400px]">
            <h3 className="font-semibold mb-4 text-lg">AI Financial Narrative</h3>
            {reportResult ? (
              <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap leading-relaxed text-muted-foreground">
                {reportResult}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50 pb-12">
                <TrendingUp className="w-12 h-12 mb-3" />
                <p>Fill out the data to generate a P&L narrative.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'risk' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="font-semibold mb-4 text-lg">Risk Scenario</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Scenario Description</label>
                <textarea value={riskForm.description} onChange={e => setRiskForm({...riskForm, description: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm h-24" placeholder="e.g. Planning to expand into European markets while taking a $500k loan." />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Market Context (Optional)</label>
                <textarea value={riskForm.market_context} onChange={e => setRiskForm({...riskForm, market_context: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm h-20" placeholder="e.g. Interest rates are rising, European market is volatile." />
              </div>
              <Button onClick={assessRisk} disabled={assessingRisk} className="w-full bg-emerald-600 hover:bg-emerald-700">
                {assessingRisk ? 'Assessing...' : 'Run Risk Assessment'}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="font-semibold mb-4 text-lg">Assessment Results</h3>
            {riskResult ? (
              <div className="space-y-6">
                <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border border-border">
                  <div>
                    <p className="text-sm text-muted-foreground">Risk Level</p>
                    <p className={cn("text-xl font-bold", riskResult.risk_level === 'High' ? 'text-red-500' : riskResult.risk_level === 'Medium' ? 'text-yellow-500' : 'text-emerald-500')}>
                      {riskResult.risk_level}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">Risk Score</p>
                    <div className="flex items-center justify-end space-x-2">
                      <AlertTriangle className={cn("w-5 h-5", riskResult.risk_level === 'High' ? 'text-red-500' : riskResult.risk_level === 'Medium' ? 'text-yellow-500' : 'text-emerald-500')} />
                      <p className="text-3xl font-bold">{riskResult.score}<span className="text-lg text-muted-foreground">/100</span></p>
                    </div>
                  </div>
                </div>
                
                <div>
                  <h4 className="font-semibold mb-2 flex items-center"><ShieldAlert className="w-4 h-4 mr-2 text-emerald-500" /> Recommended Mitigations</h4>
                  <ul className="space-y-2">
                    {riskResult.mitigations?.map((m: string, i: number) => (
                      <li key={i} className="flex items-start">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-2 mr-2 shrink-0"></span>
                        <span className="text-sm text-muted-foreground leading-relaxed">{m}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50 pb-8 min-h-[200px]">
                <ShieldAlert className="w-12 h-12 mb-3" />
                <p>Run an assessment to see risk scores.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'forecast' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="font-semibold mb-4 text-lg">Forecast Parameters</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Monthly Revenue ($)</label>
                <input type="number" value={forecastForm.monthly_revenue} onChange={e => setForecastForm({...forecastForm, monthly_revenue: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Fixed Costs ($)</label>
                <input type="number" value={forecastForm.fixed_costs} onChange={e => setForecastForm({...forecastForm, fixed_costs: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Variable Costs ($)</label>
                <input type="number" value={forecastForm.variable_costs} onChange={e => setForecastForm({...forecastForm, variable_costs: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Monthly Growth Rate (%)</label>
                <input type="number" value={forecastForm.growth_rate} onChange={e => setForecastForm({...forecastForm, growth_rate: e.target.value})} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <Button onClick={generateForecast} disabled={generatingForecast} className="bg-emerald-600 hover:bg-emerald-700">
              {generatingForecast ? 'Projecting...' : 'Generate 12-Month Projection'}
            </Button>
          </div>

          {forecastResult.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5 overflow-x-auto">
              <h3 className="font-semibold mb-4 text-lg">12-Month Projection</h3>
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 rounded-tl-lg">Month</th>
                    <th className="px-4 py-3">Revenue</th>
                    <th className="px-4 py-3">Expenses</th>
                    <th className="px-4 py-3 rounded-tr-lg">Net Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {(Array.isArray(forecastResult) ? forecastResult : []).map((monthData, idx) => (
                    <tr key={idx} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium">{monthData.month}</td>
                      <td className="px-4 py-3 text-emerald-500 font-medium">{"$"}{Number(monthData.revenue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td className="px-4 py-3 text-red-500 font-medium">{"$"}{Number(monthData.expenses).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td className={cn("px-4 py-3 font-bold", Number(monthData.profit) >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                        {"$"}{Number(monthData.profit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
