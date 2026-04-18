// ── Finance logic shared with web ──────────────────────────────────────────
// CommonJS-compatible (no `export` keyword) so it works in both environments.

const TRANSFER_PATTERNS = [
  'pay chris & mel atkins',
  'c & m a atkins',
  'mb transfer to card',
  'thank you mb transfer',
  /to card \d+/i,
  /card \d{3,} payment received/i,
  /payment received[\s\-]*thank you/i,
  /credit card (payment|autopay|auto pay)/i,
  /visa (payment|autopay|auto pay|direct debit)/i,
  /mastercard (payment|autopay|auto pay)/i,
  /(internet|mobile|online) banking (transfer|payment)/i,
  /internal transfer/i,
];

const EXCLUDED_TYPES = new Set(['TRANSFER', 'CREDIT CARD']);

function isTransfer(desc) {
  if (!desc) return false;
  const l = desc.toLowerCase();
  return TRANSFER_PATTERNS.some(p =>
    typeof p === 'string' ? l.includes(p) : p.test(desc)
  );
}

function isExcluded(tx, internalIds = new Set()) {
  if (tx.type && EXCLUDED_TYPES.has(tx.type)) return true;
  if (isTransfer(tx.description)) return true;
  if (internalIds.has(tx._id)) return true;
  return false;
}

function detectInternalTransfers(transactions) {
  const byDateAmt = {};
  transactions.forEach(tx => {
    const day = tx.date ? tx.date.split('T')[0] : '';
    const key = `${day}_${Math.abs(tx.amount).toFixed(2)}`;
    (byDateAmt[key] = byDateAmt[key] || []).push(tx);
  });
  const ids = new Set();
  Object.values(byDateAmt).forEach(group => {
    const debits  = group.filter(tx => tx.amount < 0);
    const credits = group.filter(tx => tx.amount > 0);
    debits.forEach(d => {
      credits.forEach(c => {
        if (d._account !== c._account) { ids.add(d._id); ids.add(c._id); }
      });
    });
  });
  return ids;
}

const CATEGORIES = [
  { name: 'Groceries',         color: '#22d99a', keywords: ['countdown','pak n save','paknsave','new world','fresh choice','foursquare','four square','woolworths','supermarket','produce','butcher','bakery'] },
  { name: 'Transport',         color: '#4f88ff', keywords: ['petrol','fuel','bp ','z energy','mobil','gull','caltex','challenge fuel','uber','ola ','taxi','parking','at hop','hop card','nzta','waka kotahi'] },
  { name: 'Dining & Cafes',    color: '#f59e0b', keywords: ['restaurant','cafe','coffee','espresso','mcdonald','kfc','burger','pizza','subway','sushi','noodle','takeaway','dominos','hell pizza','grill',' bar ','pub ','tavern','bistro','eatery','diner','kebab'] },
  { name: 'Shopping',          color: '#a855f7', keywords: ['amazon','the warehouse','kmart','farmers ','briscoes','noel leeming','jb hi-fi','rebel sport','hallensteins','glassons','cotton on','trade me','aliexpress','shein','temu'] },
  { name: 'Health & Fitness',  color: '#06b6d4', keywords: ['pharmacy','chemist','doctor','dental','medical','clinic','hospital','gym','fitness','les mills','anytime fitness','jetts','physio','health'] },
  { name: 'Entertainment',     color: '#ec4899', keywords: ['netflix','spotify','disney','apple tv','youtube premium','cinema','hoyts','movie','concert','ticketek','steam','playstation','xbox','sky tv','neon '] },
  { name: 'Utilities & Bills', color: '#64748b', keywords: ['power','electricity','contact energy','mercury energy','genesis','vector','water rate','internet','spark','vodafone','one nz','2degrees','chorus','skinny','broadband','council rates'] },
  { name: 'Insurance',         color: '#8b7cf6', keywords: ['insurance','ami ','aa insurance','state insurance','tower insurance','southern cross','fidelity life','partners life'] },
  { name: 'Travel',            color: '#f97316', keywords: ['air new zealand','airnz','jetstar','qantas','hotel','motel','airbnb','booking.com','expedia','accommodation'] },
  { name: 'Tax',               color: '#94a3b8', keywords: ['inland revenue','ird ','inland revenue department'] },
];

function categorize(desc) {
  if (!desc) return 'Other';
  const l = desc.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some(k => l.includes(k))) return cat.name;
  }
  return 'Other';
}

function categoryColor(name) {
  return CATEGORIES.find(c => c.name === name)?.color || '#5c5c80';
}

function buildTxByMonth(transactions, internalIds) {
  const map = {};
  transactions.forEach(tx => {
    if (isExcluded(tx, internalIds)) return;
    const d = new Date(tx.date);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    (map[k] = map[k] || []).push(tx);
  });
  return map;
}

function isSavingsTx(tx, merchantOverrides) {
  if (!tx || tx.amount >= 0) return false;
  const overrides = merchantOverrides || new Map();
  const override = overrides.get(normMerchant(tx.description));
  if (override === 'savings') return true;
  if (override) return false;
  return /rabo/i.test(tx.description || '');
}

function statsFor(txByMonth, k, merchantOverrides) {
  const txs = txByMonth[k] || [];
  let income = 0, expense = 0, savings = 0;
  const catMap = {};
  txs.forEach(tx => {
    if (tx.amount > 0) {
      income += tx.amount;
      return;
    }
    const a = Math.abs(tx.amount);
    if (isSavingsTx(tx, merchantOverrides)) {
      savings += a;
      return;
    }
    expense += a;
    const cat = categorize(tx.description);
    catMap[cat] = (catMap[cat] || 0) + a;
  });
  const categories = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value, color: categoryColor(name) }));
  return { income, expense, savings, categories };
}

// ── Three-bucket classification ─────────────────────────────────────────────
const ALWAYS_COMMITTED_CATS     = new Set(['Utilities & Bills', 'Insurance']);
const ALWAYS_DISCRETIONARY_CATS = new Set(['Groceries', 'Dining & Cafes', 'Shopping', 'Transport', 'Travel']);

function normMerchant(desc) {
  return (desc || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const ONEOFF_THRESHOLD = 5000;

// merchantOverrides: Map<normMerchant, 'committed'|'discretionary'|'oneoff'>
function classifyTransactions(txByMonth, monthKeys, merchantOverrides) {
  if (!merchantOverrides) merchantOverrides = new Map();

  const merchantMonthSet = {};
  monthKeys.forEach(mk => {
    (txByMonth[mk] || []).forEach(tx => {
      if (tx.amount >= 0) return;
      const m = normMerchant(tx.description);
      if (!merchantMonthSet[m]) merchantMonthSet[m] = new Set();
      merchantMonthSet[m].add(mk);
    });
  });

  const fixedSubIds = new Set();
  const subIndex = {};
  monthKeys.forEach(mk => {
    (txByMonth[mk] || []).forEach(tx => {
      if (tx.amount >= 0) return;
      const cents = Math.round(Math.abs(tx.amount) * 100);
      if (cents < 1000) return;
      const key = `${cents}|${normMerchant(tx.description)}`;
      if (!subIndex[key]) subIndex[key] = {};
      if (!subIndex[key][mk]) subIndex[key][mk] = [];
      subIndex[key][mk].push(tx._id);
    });
  });
  Object.values(subIndex).forEach(monthMap => {
    const entries = Object.entries(monthMap);
    if (entries.length < 2) return;
    if (entries.some(([, ids]) => ids.length > 1)) return;
    entries.forEach(([, ids]) => fixedSubIds.add(ids[0]));
  });

  const committedIds      = new Set();
  const discretionaryIds  = new Set();
  const oneoffIds         = new Set();
  const savingsIds        = new Set();
  const freqDiscSpend     = {};

  monthKeys.forEach(mk => {
    (txByMonth[mk] || []).forEach(tx => {
      if (tx.amount >= 0) return;
      const amt      = Math.abs(tx.amount);
      const merchant = normMerchant(tx.description);
      const cat      = categorize(tx.description);
      const override = merchantOverrides.get(merchant);

      if (override) {
        if (override === 'committed')     committedIds.add(tx._id);
        else if (override === 'discretionary') discretionaryIds.add(tx._id);
        else if (override === 'oneoff')   oneoffIds.add(tx._id);
        else if (override === 'savings')  savingsIds.add(tx._id);
        return;
      }
      if (/rabo/i.test(tx.description || '')) { savingsIds.add(tx._id); return; }
      if (amt >= ONEOFF_THRESHOLD) { oneoffIds.add(tx._id); return; }
      if (ALWAYS_COMMITTED_CATS.has(cat)) { committedIds.add(tx._id); return; }
      if (fixedSubIds.has(tx._id) && !ALWAYS_DISCRETIONARY_CATS.has(cat)) { committedIds.add(tx._id); return; }
      if (ALWAYS_DISCRETIONARY_CATS.has(cat)) {
        discretionaryIds.add(tx._id);
        if ((merchantMonthSet[merchant]?.size || 0) >= 3)
          freqDiscSpend[merchant] = (freqDiscSpend[merchant] || 0) + amt;
        return;
      }
      if ((merchantMonthSet[merchant]?.size || 0) >= 3) { committedIds.add(tx._id); return; }
      discretionaryIds.add(tx._id);
    });
  });

  // frequentDiscretionary: Map<merchant, avgMonthlySpend>
  const frequentDiscretionary = new Map();
  Object.entries(freqDiscSpend).forEach(([merchant, total]) => {
    const months = merchantMonthSet[merchant]?.size || 1;
    frequentDiscretionary.set(merchant, total / months);
  });

  return { committedIds, discretionaryIds, oneoffIds, savingsIds, frequentDiscretionary };
}

function threeWayStats(txByMonth, k, committedIds, discretionaryIds, oneoffIds, savingsIds) {
  const txs = (txByMonth[k] || []).filter(tx => tx.amount < 0);
  if (!savingsIds) savingsIds = new Set();
  let committed = 0, discretionary = 0, oneoffs = 0, savings = 0;
  const committedMap = {}, discretionaryMap = {}, oneoffMap = {}, savingsMap = {};

  txs.forEach(tx => {
    const amt   = Math.abs(tx.amount);
    const label = normMerchant(tx.description);
    if (savingsIds.has(tx._id)) {
      savings += amt;
      savingsMap[label] = (savingsMap[label] || 0) + amt;
    } else if (committedIds.has(tx._id)) {
      committed += amt;
      committedMap[label] = (committedMap[label] || 0) + amt;
    } else if (oneoffIds.has(tx._id)) {
      oneoffs += amt;
      oneoffMap[label] = (oneoffMap[label] || 0) + amt;
    } else {
      discretionary += amt;
      discretionaryMap[label] = (discretionaryMap[label] || 0) + amt;
    }
  });

  const topFromMap = (map, n) => Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n || 10)
    .map(([merchant, value]) => ({ merchant, value }));

  return {
    committed, discretionary, oneoffs, savings,
    topCommitted:     topFromMap(committedMap),
    topDiscretionary: topFromMap(discretionaryMap),
    topOneoffs:       topFromMap(oneoffMap),
    topSavings:       topFromMap(savingsMap),
  };
}

function getMidMonthStatus(txByMonth, k, avgExpense, merchantOverrides) {
  const [year, month] = k.split('-').map(Number);
  const today = new Date();
  if (today.getFullYear() !== year || today.getMonth() + 1 !== month) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dayOfMonth  = today.getDate();
  const stats       = statsFor(txByMonth, k, merchantOverrides);
  const dailyRate   = dayOfMonth > 0 ? stats.expense / dayOfMonth : 0;
  const projected   = Math.round(dailyRate * daysInMonth);
  const vsAvg       = avgExpense > 0 ? Math.round((projected - avgExpense) / avgExpense * 100) : 0;
  return { dayOfMonth, daysInMonth, pctThrough: Math.round(dayOfMonth / daysInMonth * 100), spent: stats.expense, income: stats.income, projected, avgExpense: Math.round(avgExpense), vsAvg };
}

const fmt    = v => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-NZ');
const mKey   = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
const mLabel = k => { const [y,m]=k.split('-'); return new Date(+y,+m-1,1).toLocaleString('en-NZ',{month:'long',year:'numeric'}); };
const mShort = k => { const [y,m]=k.split('-'); return new Date(+y,+m-1,1).toLocaleString('en-NZ',{month:'short'}); };

module.exports = {
  isTransfer, isExcluded, detectInternalTransfers,
  CATEGORIES, categorize, categoryColor,
  buildTxByMonth, statsFor, isSavingsTx,
  normMerchant, classifyTransactions, threeWayStats,
  getMidMonthStatus,
  fmt, mKey, mLabel, mShort,
};
