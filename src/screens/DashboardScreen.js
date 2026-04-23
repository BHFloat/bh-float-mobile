import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, RefreshControl, ActivityIndicator,
  StatusBar, Alert, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
const {
  buildTxByMonth, detectInternalTransfers, statsFor,
  classifyTransactions, threeWayStats, getMidMonthStatus,
  fmt, mKey, mLabel, mShort, CATEGORIES, categorize, categoryColor,
  isExcluded,
} = require('../lib/finance');
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const AKAHU_PROXY = process.env.EXPO_PUBLIC_AKAHU_PROXY_URL
  || Constants.expoConfig?.extra?.akahuProxyUrl
  || '';

function fiveYearsAgo() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().split('T')[0];
}

async function fetchAkahuPages(userToken, appToken, since, until) {
  const headers = {
    'x-user-token': userToken,
    'x-app-token': appToken,
    'Content-Type': 'application/json',
  };
  const endParam = until ? `&end=${until}` : '';
  let all = [];
  let cursor = null;
  do {
    const url = `${AKAHU_PROXY}/api/akahu/transactions?start=${since}${endParam}${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Akahu fetch failed: ${res.status}`);
    const data = await res.json();
    all = all.concat(data.items || []);
    cursor = data.cursor?.next || null;
  } while (cursor);
  return all;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function MetricCard({ label, value, valueColor, sub, accentColor }) {
  return (
    <View style={[styles.metricCard, { borderTopColor: accentColor, borderTopWidth: 2 }]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color: valueColor }]}>{value}</Text>
      {!!sub && <Text style={styles.metricSub}>{sub}</Text>}
    </View>
  );
}

function CategoryRow({ cat, value, total, onPress }) {
  const pctWidth = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <TouchableOpacity style={styles.catRow} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.catRowLeft}>
        <View style={[styles.catDot, { backgroundColor: cat.color }]} />
        <Text style={styles.catName} numberOfLines={1}>{cat.name}</Text>
      </View>
      <View style={styles.catRowRight}>
        <View style={styles.catBarBg}>
          <View style={[styles.catBarFill, { width: `${pctWidth}%`, backgroundColor: cat.color }]} />
        </View>
        <Text style={styles.catValue}>{fmt(value)}</Text>
      </View>
    </TouchableOpacity>
  );
}

function TxRow({ tx }) {
  const isCredit = tx.amount > 0;
  return (
    <View style={styles.txRow}>
      <View style={[styles.txDot, { backgroundColor: isCredit ? '#22d99a' : categoryColor(tx._cat) }]} />
      <View style={styles.txMiddle}>
        <Text style={styles.txDesc} numberOfLines={1}>{tx.description}</Text>
        <Text style={styles.txDate}>{tx.date?.split('T')[0]}</Text>
      </View>
      <Text style={[styles.txAmt, { color: isCredit ? '#22d99a' : '#e8eaf6' }]}>
        {isCredit ? '+' : ''}{fmt(tx.amount)}
      </Text>
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────

export default function DashboardScreen({ navigation }) {
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState('');
  const [accounts,   setAccounts]   = useState([]);
  const [txByMonth,  setTxByMonth]  = useState({});
  const [monthKeys,  setMonthKeys]  = useState([]);
  const [currentKey, setCurrentKey] = useState('');
  const [userEmail,  setUserEmail]  = useState('');
  const [userId,     setUserId]     = useState('');
  const [search,     setSearch]     = useState('');
  const [catFilter,  setCatFilter]  = useState(null);
  const [activeTab,  setActiveTab]  = useState('overview'); // 'overview' | 'transactions'
  const [rawTxItems,        setRawTxItems]        = useState([]);
  const [excludedIds,       setExcludedIds]       = useState(new Set());
  const [merchantOverrides, setMerchantOverrides] = useState(new Map());

  const buildState = useCallback((txItems, accs, excIds = new Set(), preserveKey = false) => {
    const internalIds = detectInternalTransfers(txItems);
    const statsItems = txItems.filter(tx => !isExcluded(tx, internalIds) && !excIds.has(tx._id));
    const map = buildTxByMonth(statsItems, new Set());
    const keys = Object.keys(map).sort();
    setTxByMonth(map);
    setMonthKeys(keys);
    setAccounts(accs);
    if (preserveKey) {
      setCurrentKey(prev => (keys.includes(prev) ? prev : keys[keys.length - 1] || ''));
    } else {
      setCurrentKey(keys[keys.length - 1] || '');
    }
  }, []);

  async function toggleExclude(txId) {
    const next = new Set(excludedIds);
    if (next.has(txId)) next.delete(txId);
    else next.add(txId);
    setExcludedIds(next);
    if (userId) {
      await AsyncStorage.setItem(`excl_${userId}`, JSON.stringify([...next]));
    }
    if (rawTxItems.length > 0) buildState(rawTxItems, accounts, next, true);
  }

  const loadData = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      setUserEmail(session.user.email || '');
      const uid = session.user.id;
      setUserId(uid);

      // Load manually excluded IDs
      try {
        const stored = await AsyncStorage.getItem(`excl_${uid}`);
        if (stored) setExcludedIds(new Set(JSON.parse(stored)));
      } catch (_) {}

      // Load merchant overrides (set on web, respected on mobile)
      const { data: overrides } = await supabase
        .from('merchant_overrides')
        .select('merchant, classification')
        .eq('user_id', uid);
      if (overrides?.length) {
        setMerchantOverrides(new Map(overrides.map(r => [r.merchant, r.classification])));
      }

      const userId = uid;

      const { data: tokenRows } = await supabase
        .from('user_tokens')
        .select('akahu_user_token, akahu_app_token')
        .eq('user_id', userId)
        .limit(1);

      if (!tokenRows || tokenRows.length === 0) {
        setError('No Akahu tokens found. Please add them on the web app.');
        setLoading(false);
        return;
      }
      const { akahu_user_token: ut, akahu_app_token: at } = tokenRows[0];
      const headers = {
        'x-user-token': ut,
        'x-app-token': at,
        'Content-Type': 'application/json',
      };

      // Load accounts + cached transactions in parallel
      const [accRes, { data: cached }] = await Promise.all([
        fetch(`${AKAHU_PROXY}/api/akahu/accounts`, { headers }),
        supabase.from('transactions').select('raw').eq('user_id', userId),
      ]);

      const accData = await accRes.json();
      const accs = accData.items || [];

      if (cached && cached.length > 0) {
        // Show cached data immediately
        const items = cached.map(r => r.raw);
        setRawTxItems(items);
        buildState(items, accs, excludedIds);
        setLoading(false);

        // Forward sync
        const dates = items.map(t => t.date?.split('T')[0]).filter(Boolean).sort();
        const latestDate = dates[dates.length - 1] || fiveYearsAgo();
        const syncSince = new Date(new Date(latestDate) - 2 * 86400000).toISOString().split('T')[0];
        const fresh = await fetchAkahuPages(ut, at, syncSince);
        let allItems = items;
        if (fresh.length > 0) {
          const merged = [...items];
          const existingIds = new Set(items.map(t => t._id));
          fresh.forEach(t => {
            if (!existingIds.has(t._id)) merged.push(t);
            else { const i = merged.findIndex(x => x._id === t._id); if (i >= 0) merged[i] = t; }
          });
          const rows = fresh.map(t => ({ user_id: userId, id: t._id, raw: t }));
          for (let i = 0; i < rows.length; i += 500) {
            await supabase.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,id' });
          }
          allItems = merged;
          setRawTxItems(allItems);
          buildState(allItems, accs, excludedIds);
        }

        // Repair window — re-fetch last 120 days to heal middle-of-cache gaps.
        // Upsert dedupes via onConflict:user_id,id so this only fills holes.
        try {
          const repairStart = new Date(Date.now() - 120 * 86400000).toISOString().split('T')[0];
          const repair = await fetchAkahuPages(ut, at, repairStart);
          if (repair.length > 0) {
            const repairIds = new Set(repair.map(t => t._id));
            const merged = [...allItems.filter(t => !repairIds.has(t._id)), ...repair];
            const rows = repair.map(t => ({ user_id: userId, id: t._id, raw: t }));
            for (let i = 0; i < rows.length; i += 500) {
              await supabase.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,id' });
            }
            allItems = merged;
            setRawTxItems(allItems);
            buildState(allItems, accs, excludedIds);
          }
        } catch (e) {
          console.warn('Repair window fetch failed:', e.message);
        }

        // Backward backfill — chunked into 1-year windows because Akahu 400s on
        // wide ranges, and wrapped so a partial failure doesn't abort the sync.
        const oldestDate = allItems.map(t => t.date?.split('T')[0]).filter(Boolean).sort().at(0);
        const targetStart = fiveYearsAgo();
        if (oldestDate && oldestDate > targetStart) {
          let windowEnd = new Date(new Date(oldestDate) - 86400000);
          const stopAt  = new Date(targetStart);
          let iter = 0;
          while (windowEnd > stopAt && iter++ < 6) {
            const windowStart = new Date(windowEnd);
            windowStart.setFullYear(windowStart.getFullYear() - 1);
            const startStr = (windowStart < stopAt ? stopAt : windowStart).toISOString().split('T')[0];
            const endStr   = windowEnd.toISOString().split('T')[0];
            try {
              const hist = await fetchAkahuPages(ut, at, startStr, endStr);
              if (hist.length > 0) {
                const rows = hist.map(t => ({ user_id: userId, id: t._id, raw: t }));
                for (let i = 0; i < rows.length; i += 500) {
                  await supabase.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,id' });
                }
                allItems = [...hist, ...allItems];
                setRawTxItems(allItems);
                buildState(allItems, accs, excludedIds);
              }
            } catch (e) {
              console.warn('Backfill stopped at', startStr, '→', endStr, ':', e.message);
              break;
            }
            windowEnd = new Date(new Date(startStr) - 86400000);
          }
        }
      } else {
        // First load: full 12 months
        const items = await fetchAkahuPages(ut, at, fiveYearsAgo());
        const rows = items.map(t => ({ user_id: userId, id: t._id, raw: t }));
        for (let i = 0; i < rows.length; i += 500) {
          await supabase.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,id' });
        }
        setRawTxItems(items);
        buildState(items, accs, excludedIds);
        setLoading(false);
      }
    } catch (e) {
      console.error(e);
      setError(e.message || 'Failed to load data');
      setLoading(false);
    }
  }, [buildState]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    // Navigation handled by auth listener in App.js
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  // ── Derived state ────────────────────────────────────────────────────────
  const currentIdx = monthKeys.indexOf(currentKey);
  const stats      = currentKey ? statsFor(txByMonth, currentKey, merchantOverrides) : { income: 0, expense: 0, savings: 0, categories: [] };
  const midMonth   = currentKey ? getMidMonthStatus(txByMonth, currentKey, stats.expense, merchantOverrides) : null;

  const { committedIds, discretionaryIds, oneoffIds, savingsIds, frequentDiscretionary } =
    classifyTransactions(txByMonth, monthKeys, merchantOverrides);

  const threeWay = currentKey
    ? threeWayStats(txByMonth, currentKey, committedIds, discretionaryIds, oneoffIds, savingsIds)
    : { committed: 0, discretionary: 0, oneoffs: 0, savings: 0, topCommitted: [], topDiscretionary: [], topOneoffs: [], topSavings: [] };

  const allMonthStats = monthKeys.map(mk => ({ k: mk, ...statsFor(txByMonth, mk, merchantOverrides) }));
  const avgExpense = allMonthStats.length
    ? allMonthStats.reduce((sum, m) => sum + m.expense, 0) / allMonthStats.length : 0;

  const catTotals = {}, catCounts = {};
  allMonthStats.forEach(ms => (ms.categories || []).forEach(({ name, value }) => {
    catTotals[name] = (catTotals[name] || 0) + value;
    catCounts[name] = (catCounts[name] || 0) + 1;
  }));
  const catAvg = name => catCounts[name] ? catTotals[name] / catCounts[name] : 0;

  // Insights
  const insights = [];
  stats.categories.forEach(({ name, value }) => {
    const avg = catAvg(name);
    if (avg > 40 && value > avg * 1.2) {
      const pctOver = Math.round((value - avg) / avg * 100);
      insights.push({ type: 'warn', text: `${name} is ${pctOver}% above your average this month.` });
    }
  });
  if (avgExpense > 0 && stats.expense > avgExpense * 1.15)
    insights.push({ type: 'warn', text: `Overall spending is ${Math.round((stats.expense - avgExpense) / avgExpense * 100)}% above your average.` });
  frequentDiscretionary.forEach((avgSpend, merchant) => {
    insights.push({ type: 'suggest', text: `${merchant} — ${fmt(Math.round(avgSpend))}/mo avg, appears every month. Mark as committed if it's a fixed bill.` });
  });
  threeWay.topCommitted.forEach(({ merchant, value }) => {
    if (value >= 10 && categorize(merchant) === 'Entertainment')
      insights.push({ type: 'suggest', text: `${merchant} (${fmt(value)}/mo) — is this subscription still being used?` });
  });

  const totalBalance = accounts.reduce((s, a) => s + (a.balance?.current || 0), 0);

  // Display transactions — include excluded items but mark them
  const rawMonth = currentKey ? rawTxItems.filter(tx => {
    const d = new Date(tx.date);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return mk === currentKey;
  }) : [];

  const currentTxs = rawMonth
    .filter(tx => {
      if (catFilter && categorize(tx) !== catFilter) return false;
      if (search && !tx.description?.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .map(tx => ({ ...tx, _cat: categorize(tx) }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // ── Loading / error screens ───────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centreScreen}>
        <StatusBar barStyle="light-content" backgroundColor="#0d0d16" />
        <ActivityIndicator color="#4f88ff" size="large" />
        <Text style={styles.loadingText}>Loading your finances…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centreScreen}>
        <StatusBar barStyle="light-content" backgroundColor="#0d0d16" />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={loadData}>
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d16" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>BH Float</Text>
          <Text style={styles.headerSub}>
            {accounts.length} account{accounts.length !== 1 ? 's' : ''} · {fmt(totalBalance)}
          </Text>
        </View>
        <TouchableOpacity onPress={handleSignOut} style={styles.signOutBtn}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {/* Month navigation */}
      <View style={styles.monthNav}>
        <TouchableOpacity
          onPress={() => setCurrentKey(monthKeys[currentIdx - 1])}
          disabled={currentIdx <= 0}
          style={[styles.navBtn, currentIdx <= 0 && styles.navBtnDisabled]}
        >
          <Text style={styles.navBtnText}>
            ← {currentIdx > 0 ? mShort(monthKeys[currentIdx - 1]) : ''}
          </Text>
        </TouchableOpacity>

        <Text style={styles.monthLabel}>{currentKey ? mLabel(currentKey) : ''}</Text>

        <TouchableOpacity
          onPress={() => setCurrentKey(monthKeys[currentIdx + 1])}
          disabled={currentIdx >= monthKeys.length - 1}
          style={[styles.navBtn, currentIdx >= monthKeys.length - 1 && styles.navBtnDisabled]}
        >
          <Text style={styles.navBtnText}>
            {currentIdx < monthKeys.length - 1 ? mShort(monthKeys[currentIdx + 1]) : ''} →
          </Text>
        </TouchableOpacity>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {['overview', 'transactions'].map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4f88ff" />}
        showsVerticalScrollIndicator={false}
      >
        {activeTab === 'overview' ? (
          <>
            {/* Metric cards */}
            <View style={styles.metricsRow}>
              <MetricCard label="Income"   value={fmt(stats.income)}  valueColor="#22d99a" accentColor="#22d99a" />
              <MetricCard label="Expenses" value={fmt(stats.expense)} valueColor="#ff6b6b" accentColor="#ff6b6b" />
              <MetricCard label="Savings"  value={fmt(stats.savings || 0)} valueColor="#14b8a6" accentColor="#14b8a6" />
              <MetricCard
                label="Net"
                value={fmt(stats.income - stats.expense - (stats.savings || 0))}
                valueColor={stats.income - stats.expense - (stats.savings || 0) >= 0 ? '#22d99a' : '#ff6b6b'}
                accentColor="#4f88ff"
              />
            </View>

            {/* Mid-month pace */}
            {midMonth && (
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Mid-month pace</Text>
                <View style={styles.midMonthRow}>
                  <View style={styles.midMonthBarBg}>
                    <View style={[styles.midMonthBarFill, { width: `${midMonth.pctThrough}%` }]} />
                  </View>
                  <Text style={styles.midMonthPct}>{midMonth.pctThrough}% through month</Text>
                </View>
                <View style={styles.midMonthStats}>
                  <View style={styles.midMonthStat}>
                    <Text style={styles.midMonthStatLabel}>Spent so far</Text>
                    <Text style={styles.midMonthStatValue}>{fmt(midMonth.spent)}</Text>
                  </View>
                  <View style={styles.midMonthStat}>
                    <Text style={styles.midMonthStatLabel}>Projected</Text>
                    <Text style={[styles.midMonthStatValue, { color: midMonth.vsAvg > 10 ? '#ff6b6b' : midMonth.vsAvg < -10 ? '#22d99a' : '#e8eaf6' }]}>
                      {fmt(midMonth.projected)}
                    </Text>
                  </View>
                  <View style={styles.midMonthStat}>
                    <Text style={styles.midMonthStatLabel}>Monthly avg</Text>
                    <Text style={styles.midMonthStatValue}>{fmt(midMonth.avgExpense)}</Text>
                  </View>
                </View>
              </View>
            )}

            {/* Spend classification summary */}
            <TouchableOpacity
              style={styles.panel}
              onPress={() => navigation.navigate('Committed', {
                committed:        threeWay.committed,
                discretionary:    threeWay.discretionary,
                oneoffs:          threeWay.oneoffs,
                savings:          threeWay.savings,
                topCommitted:     threeWay.topCommitted,
                topDiscretionary: threeWay.topDiscretionary,
                topOneoffs:       threeWay.topOneoffs,
                topSavings:       threeWay.topSavings,
                monthLabel:       mLabel(currentKey),
              })}
              activeOpacity={0.85}
            >
              <Text style={styles.panelTitle}>Spend Classification</Text>
              <View style={styles.committedRow}>
                <View style={styles.committedStat}>
                  <Text style={styles.committedLabel}>Committed</Text>
                  <Text style={[styles.committedValue, { color: '#8b7cf6' }]}>{fmt(threeWay.committed)}</Text>
                </View>
                <View style={styles.committedDivider} />
                <View style={styles.committedStat}>
                  <Text style={styles.committedLabel}>Discretionary</Text>
                  <Text style={[styles.committedValue, { color: '#f59e0b' }]}>{fmt(threeWay.discretionary)}</Text>
                </View>
                <View style={styles.committedDivider} />
                <View style={styles.committedStat}>
                  <Text style={styles.committedLabel}>One-offs</Text>
                  <Text style={[styles.committedValue, { color: '#64748b' }]}>{fmt(threeWay.oneoffs)}</Text>
                </View>
                <View style={styles.committedDivider} />
                <View style={styles.committedStat}>
                  <Text style={styles.committedLabel}>Savings</Text>
                  <Text style={[styles.committedValue, { color: '#14b8a6' }]}>{fmt(threeWay.savings || 0)}</Text>
                </View>
              </View>
              <Text style={styles.panelChevron}>View details →</Text>
            </TouchableOpacity>

            {/* Spending categories */}
            {stats.categories.length > 0 && (
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Spending Categories</Text>
                {stats.categories.map(cat => (
                  <CategoryRow
                    key={cat.name}
                    cat={cat}
                    value={cat.value}
                    total={stats.expense}
                    onPress={() => {
                      setCatFilter(catFilter === cat.name ? null : cat.name);
                      setActiveTab('transactions');
                    }}
                  />
                ))}
              </View>
            )}

            {/* Insights */}
            {insights.length > 0 && (
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Insights</Text>
                {insights.slice(0, 5).map((ins, i) => (
                  <View key={i} style={[styles.insightRow, {
                    borderLeftColor: ins.type === 'warn' ? '#ff6b6b' : ins.type === 'suggest' ? '#4f88ff' : '#f59e0b',
                  }]}>
                    <Text style={styles.insightText}>{ins.text}</Text>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : (
          <>
            {/* Search + filter */}
            <View style={styles.searchRow}>
              <TextInput
                style={styles.searchInput}
                placeholder="Search transactions…"
                placeholderTextColor="#6b6d90"
                value={search}
                onChangeText={setSearch}
                clearButtonMode="while-editing"
              />
              {catFilter && (
                <TouchableOpacity style={styles.filterChip} onPress={() => setCatFilter(null)}>
                  <Text style={styles.filterChipText}>{catFilter} ×</Text>
                </TouchableOpacity>
              )}
            </View>

            {currentTxs.length === 0 ? (
              <Text style={styles.emptyText}>No transactions found</Text>
            ) : (
              <View style={styles.panel}>
                {currentTxs.map(tx => {
                  const isExcludedTx = excludedIds.has(tx._id);
                  const isCommitted  = tx.amount < 0 && committedIds.has(tx._id);
                  const isOneoff     = tx.amount < 0 && oneoffIds.has(tx._id);
                  const isSavings    = tx.amount < 0 && savingsIds.has(tx._id);
                  return (
                    <View key={tx._id} style={[styles.txRow, isExcludedTx && { opacity: 0.4 }]}>
                      <View style={[styles.txDot, { backgroundColor: tx.amount > 0 ? '#22d99a' : categoryColor(tx._cat) }]} />
                      <View style={styles.txMiddle}>
                        <Text style={[styles.txDesc, isExcludedTx && { textDecorationLine: 'line-through' }]} numberOfLines={1}>
                          {tx.description}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Text style={styles.txDate}>{tx.date?.split('T')[0]}</Text>
                          {isCommitted  && <Text style={[styles.txDate, { color: '#8b7cf6' }]}>committed</Text>}
                          {isOneoff     && <Text style={[styles.txDate, { color: '#64748b' }]}>one-off</Text>}
                          {isSavings    && <Text style={[styles.txDate, { color: '#14b8a6' }]}>savings</Text>}
                          {isExcludedTx && <Text style={styles.txDate}>excluded</Text>}
                        </View>
                      </View>
                      <Text style={[styles.txAmt, { color: tx.amount > 0 ? '#22d99a' : '#e8eaf6' }]}>
                        {tx.amount > 0 ? '+' : ''}{fmt(tx.amount)}
                      </Text>
                      <TouchableOpacity
                        onPress={() => toggleExclude(tx._id)}
                        style={[styles.excludeBtn, isExcludedTx && styles.excludeBtnActive]}
                      >
                        <Text style={[styles.excludeBtnText, isExcludedTx && styles.excludeBtnTextActive]}>
                          {isExcludedTx ? '+' : '×'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}
        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea:     { flex: 1, backgroundColor: '#0d0d16' },
  centreScreen: { flex: 1, backgroundColor: '#0d0d16', justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText:  { color: '#6b6d90', fontSize: 14, marginTop: 12 },
  errorText:    { color: '#ff6b6b', fontSize: 15, textAlign: 'center', marginBottom: 16 },
  retryBtn:     { backgroundColor: '#4f88ff', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 10 },
  retryBtnText: { color: '#fff', fontWeight: '600' },

  // Header
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  headerTitle:  { color: '#e8eaf6', fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  headerSub:    { color: '#6b6d90', fontSize: 12, marginTop: 2 },
  signOutBtn:   { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  signOutText:  { color: '#6b6d90', fontSize: 13 },

  // Month nav
  monthNav:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  navBtn:       { paddingHorizontal: 10, paddingVertical: 6 },
  navBtnDisabled: { opacity: 0.25 },
  navBtnText:   { color: '#4f88ff', fontSize: 13, fontWeight: '600' },
  monthLabel:   { color: '#e8eaf6', fontSize: 15, fontWeight: '700', letterSpacing: -0.3 },

  // Tab bar
  tabBar:       { flexDirection: 'row', marginHorizontal: 16, marginBottom: 12, backgroundColor: '#14141f', borderRadius: 10, padding: 3, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  tab:          { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 8 },
  tabActive:    { backgroundColor: '#1c1c2c' },
  tabText:      { color: '#6b6d90', fontSize: 13, fontWeight: '600' },
  tabTextActive:{ color: '#e8eaf6' },

  // Scroll
  scroll:       { flex: 1 },
  scrollContent:{ paddingHorizontal: 16 },
  bottomPad:    { height: 32 },

  // Metric cards
  metricsRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  metricCard:   { flexBasis: '48%', flexGrow: 1, backgroundColor: '#14141f', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  metricLabel:  { color: '#6b6d90', fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
  metricValue:  { fontSize: 18, fontWeight: '700', letterSpacing: -0.5 },
  metricSub:    { color: '#6b6d90', fontSize: 10, marginTop: 3 },

  // Panel
  panel:        { backgroundColor: '#14141f', borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  panelTitle:   { color: '#e8eaf6', fontSize: 13, fontWeight: '700', marginBottom: 12, letterSpacing: -0.2 },
  panelChevron: { color: '#4f88ff', fontSize: 12, marginTop: 10, textAlign: 'right' },

  // Mid-month
  midMonthRow:      { marginBottom: 12 },
  midMonthBarBg:    { height: 4, backgroundColor: '#1c1c2c', borderRadius: 2, marginBottom: 4 },
  midMonthBarFill:  { height: 4, backgroundColor: '#4f88ff', borderRadius: 2 },
  midMonthPct:      { color: '#6b6d90', fontSize: 11, textAlign: 'right' },
  midMonthStats:    { flexDirection: 'row', justifyContent: 'space-between' },
  midMonthStat:     { alignItems: 'center', flex: 1 },
  midMonthStatLabel:{ color: '#6b6d90', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  midMonthStatValue:{ color: '#e8eaf6', fontSize: 15, fontWeight: '700' },

  // Committed
  committedRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  committedStat:    { flex: 1, alignItems: 'center' },
  committedLabel:   { color: '#6b6d90', fontSize: 11, marginBottom: 4 },
  committedValue:   { fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  committedDivider: { width: 1, height: 36, backgroundColor: 'rgba(255,255,255,0.07)', marginHorizontal: 8 },

  // Categories
  catRow:       { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  catRowLeft:   { flexDirection: 'row', alignItems: 'center', width: 120 },
  catDot:       { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  catName:      { color: '#e8eaf6', fontSize: 12, flex: 1 },
  catRowRight:  { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  catBarBg:     { flex: 1, height: 4, backgroundColor: '#1c1c2c', borderRadius: 2 },
  catBarFill:   { height: 4, borderRadius: 2 },
  catValue:     { color: '#e8eaf6', fontSize: 12, fontWeight: '600', width: 60, textAlign: 'right' },

  // Transactions
  searchRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  searchInput:  { flex: 1, backgroundColor: '#14141f', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', color: '#e8eaf6', fontSize: 14, paddingHorizontal: 12, paddingVertical: 9 },
  filterChip:   { backgroundColor: '#1c1c2c', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  filterChipText:{ color: '#4f88ff', fontSize: 12 },
  emptyText:    { color: '#6b6d90', textAlign: 'center', marginTop: 40 },
  txRow:        { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  txDot:        { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  txMiddle:     { flex: 1 },
  txDesc:       { color: '#e8eaf6', fontSize: 13 },
  txDate:       { color: '#6b6d90', fontSize: 11, marginTop: 1 },
  txAmt:          { fontSize: 13, fontWeight: '600', marginLeft: 8 },
  excludeBtn:     { width: 22, height: 22, borderRadius: 6, backgroundColor: '#1c1c2c', alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  excludeBtnActive:{ backgroundColor: 'rgba(34,217,154,0.15)' },
  excludeBtnText: { color: '#6b6d90', fontSize: 12, fontWeight: '700' },
  excludeBtnTextActive: { color: '#22d99a' },

  // Insights
  insightRow:     { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 7, marginBottom: 6, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 4 },
  insightText:    { color: '#e8eaf6', fontSize: 12, lineHeight: 17 },
});
