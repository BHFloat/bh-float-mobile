import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
const { fmt } = require('../lib/finance');

function ItemRow({ merchant, value, color }) {
  return (
    <View style={styles.row}>
      <View style={[styles.rowDot, { backgroundColor: color }]} />
      <Text style={styles.rowDesc} numberOfLines={1}>{merchant}</Text>
      <Text style={styles.rowValue}>{fmt(value)}</Text>
    </View>
  );
}

const BUCKETS = [
  { key: 'committed',     label: 'Committed',     color: '#8b7cf6', hint: 'Bills, subscriptions & recurring' },
  { key: 'discretionary', label: 'Discretionary', color: '#f59e0b', hint: 'Groceries, dining, shopping & more' },
  { key: 'oneoff',        label: 'One-offs',       color: '#64748b', hint: 'Large irregular expenses (≥$5,000)' },
  { key: 'savings',       label: 'Savings',        color: '#14b8a6', hint: 'Transfers to savings accounts' },
];

const INFO = {
  committed:     'Utilities & bills, insurance, fixed subscriptions, and merchants that appear in 3+ months.',
  discretionary: 'Groceries, dining, shopping, transport and variable day-to-day spending.',
  oneoff:        'Large single expenses over $5,000, shown separately to avoid skewing your monthly picture.',
  savings:       'Money moved into savings accounts — auto-detected from descriptions containing "Rabo".',
};

export default function CommittedScreen({ route, navigation }) {
  const {
    committed, discretionary, oneoffs, savings,
    topCommitted, topDiscretionary, topOneoffs, topSavings,
    monthLabel,
  } = route.params;

  const [view, setView] = useState('committed');

  const totals = { committed, discretionary, oneoff: oneoffs, savings: savings || 0 };
  const lists  = { committed: topCommitted, discretionary: topDiscretionary, oneoff: topOneoffs, savings: topSavings || [] };
  const total  = committed + discretionary + (oneoffs || 0) + (savings || 0);
  const bucket = BUCKETS.find(b => b.key === view);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d16" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Spend Classification</Text>
        <View style={{ width: 60 }} />
      </View>
      <Text style={styles.monthLabel}>{monthLabel}</Text>

      {/* Summary cards */}
      <View style={styles.summaryRow}>
        {BUCKETS.map(b => (
          <TouchableOpacity
            key={b.key}
            style={[styles.summaryCard, view === b.key && styles.summaryCardActive]}
            onPress={() => setView(b.key)}
          >
            <Text style={styles.summaryCardLabel}>{b.label}</Text>
            <Text style={[styles.summaryCardValue, { color: b.color }]}>{fmt(totals[b.key] || 0)}</Text>
            <Text style={styles.summaryCardHint}>
              {total > 0 ? `${Math.round((totals[b.key] || 0) / total * 100)}%` : '0%'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Split bar */}
      <View style={styles.splitBarBg}>
        {total > 0 && BUCKETS.map(b => (
          <View key={b.key} style={{
            width: `${Math.round((totals[b.key] || 0) / total * 100)}%`,
            height: 4,
            backgroundColor: b.color,
          }} />
        ))}
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>
            {bucket.label} this month
          </Text>

          {(lists[view] || []).length === 0 ? (
            <Text style={styles.emptyText}>No {bucket.label.toLowerCase()} transactions this month</Text>
          ) : (
            (lists[view] || []).map((item, i) => (
              <ItemRow key={i} merchant={item.merchant} value={item.value} color={bucket.color} />
            ))
          )}
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.infoText}>{INFO[view]}</Text>
          <Text style={[styles.infoText, { marginTop: 6, color: '#4f88ff' }]}>
            Use the web app to reclassify any merchant if the auto-detection is wrong.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea:      { flex: 1, backgroundColor: '#0d0d16' },

  header:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  backBtn:       { width: 60 },
  backText:      { color: '#4f88ff', fontSize: 14 },
  headerTitle:   { color: '#e8eaf6', fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  monthLabel:    { color: '#6b6d90', fontSize: 13, textAlign: 'center', marginBottom: 12 },

  summaryRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, marginBottom: 10 },
  summaryCard:   { flexBasis: '47%', flexGrow: 1, backgroundColor: '#14141f', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  summaryCardActive: { borderColor: 'rgba(255,255,255,0.2)', backgroundColor: '#1c1c2c' },
  summaryCardLabel:  { color: '#6b6d90', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
  summaryCardValue:  { fontSize: 17, fontWeight: '700', letterSpacing: -0.5, marginBottom: 2 },
  summaryCardHint:   { color: '#6b6d90', fontSize: 10 },

  splitBarBg:    { flexDirection: 'row', marginHorizontal: 16, marginBottom: 16, borderRadius: 2, overflow: 'hidden', height: 4, backgroundColor: '#1c1c2c' },

  scroll:        { flex: 1 },
  scrollContent: { paddingHorizontal: 16 },

  panel:         { backgroundColor: '#14141f', borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  panelTitle:    { color: '#e8eaf6', fontSize: 13, fontWeight: '700', marginBottom: 12, letterSpacing: -0.2 },

  row:           { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  rowDot:        { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  rowDesc:       { flex: 1, color: '#e8eaf6', fontSize: 13, textTransform: 'capitalize' },
  rowValue:      { color: '#e8eaf6', fontSize: 13, fontWeight: '600', marginLeft: 8 },

  emptyText:     { color: '#6b6d90', fontSize: 13, textAlign: 'center', paddingVertical: 20 },

  infoBox:       { backgroundColor: '#14141f', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', marginBottom: 12 },
  infoText:      { color: '#6b6d90', fontSize: 12, lineHeight: 18 },
});
