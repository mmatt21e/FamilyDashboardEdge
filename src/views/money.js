/** Money modules: reference records, bills/expenses, and a shared monthly budget. */

import { el, emptyState, spinner, toast, formatDate } from '../ui.js';
import { state } from '../store.js';
import {
  RECORD_COLLECTIONS, budgetSummary, centsToInput, cleanText, formatMoney,
  moneyToCents, monthKey, removeRecord, saveRecord, watchRecords,
} from '../records.js';
import { collectionView, recordCard, sortNewest, sortSoonest } from './records.js';

const MONEY_CATEGORIES = [
  'Housing', 'Utilities', 'Groceries', 'Health', 'Transport', 'Travel',
  'Subscriptions', 'Gifts', 'Family', 'Other',
];

const privacyNotice = () => el('div', { class: 'card record-notice' },
  el('strong', {}, 'Keep secrets out of here'),
  el('p', { class: 'small' },
    'Use a nickname and the last four digits only. Never save passwords, PINs, full account numbers, or card numbers.'),
);

export function financialRecordsView() {
  return collectionView({
    title: 'Financial records',
    singular: 'Record',
    icon: '🏦',
    collection: RECORD_COLLECTIONS.financialRecords,
    intro: 'A family index of where important financial paperwork and accounts are kept.',
    notice: privacyNotice(),
    addLabel: 'Add a financial record',
    emptyTitle: 'No financial records yet',
    emptyMessage: 'Add a safe reference to an account, policy, tax file, or other paperwork.',
    query: { orderBy: ['updatedAt', 'desc'], limit: 300 },
    sort: sortNewest('updatedAt'),
    fields: [
      { key: 'title', label: 'Name', required: true, placeholder: 'Retirement account' },
      { key: 'type', label: 'Type', required: true, placeholder: 'Choose a type', options: ['Banking', 'Retirement', 'Insurance', 'Tax', 'Property', 'Investment', 'Other'] },
      { key: 'institution', label: 'Institution or company', placeholder: 'Company name' },
      { key: 'reference', label: 'Safe reference', placeholder: 'Nickname or last four digits', maxlength: 80 },
      { key: 'owner', label: 'Whose record?', placeholder: 'Family member or shared' },
      { key: 'location', label: 'Where the original is kept', placeholder: 'Drive folder, filing cabinet, adviser' },
      { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Useful context—never passwords or full numbers' },
    ],
    toRecord: (values) => ({
      title: cleanText(values.title, 160), type: cleanText(values.type, 80),
      institution: cleanText(values.institution, 160), reference: cleanText(values.reference, 80),
      owner: cleanText(values.owner, 120), location: cleanText(values.location, 300),
      notes: cleanText(values.notes, 3000),
    }),
    renderCard: (record) => recordCard(record.title, {
      eyebrow: record.type,
      meta: [record.institution, record.reference, record.owner].filter(Boolean),
      body: [record.location && `Original: ${record.location}`, record.notes].filter(Boolean).join('\n'),
    }),
    deletePrompt: (record) => `Delete “${record.title}”? This removes only the dashboard reference, not the original file.`,
  });
}

export function expensesView() {
  return collectionView({
    title: 'Bills & expenses',
    singular: 'Bill or expense',
    icon: '🧾',
    collection: RECORD_COLLECTIONS.expenses,
    intro: 'Track upcoming bills and shared spending without storing payment credentials.',
    addLabel: 'Add a bill or expense',
    emptyTitle: 'Nothing recorded',
    emptyMessage: 'Add a bill, subscription, trip cost, or other shared expense.',
    query: { orderBy: ['dueDate', 'asc'], limit: 500 },
    sort: sortSoonest('dueDate'),
    fields: [
      { key: 'title', label: 'What is it?', required: true, placeholder: 'Electric bill' },
      { key: 'amount', label: 'Amount', type: 'number', required: true, min: '0', step: '0.01', placeholder: '0.00', fromRecord: (record) => centsToInput(record.amountCents) },
      { key: 'category', label: 'Category', required: true, placeholder: 'Choose a category', options: MONEY_CATEGORIES },
      { key: 'dueDate', label: 'Due or purchase date', type: 'date', required: true },
      { key: 'frequency', label: 'Repeats', options: ['One time', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'], placeholder: 'Choose frequency' },
      { key: 'status', label: 'Status', options: [
        { value: 'due', label: 'Due' }, { value: 'autopay', label: 'Automatic payment' }, { value: 'paid', label: 'Paid' },
      ], defaultValue: 'due' },
      { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Who is paying, what it covers, or where the receipt is' },
    ],
    toRecord: (values) => {
      const amountCents = moneyToCents(values.amount);
      if (amountCents == null) return { error: 'Enter a valid amount.' };
      return {
        title: cleanText(values.title, 160), amountCents, category: cleanText(values.category, 80),
        dueDate: values.dueDate, frequency: cleanText(values.frequency, 40) || 'One time',
        status: values.status || 'due', notes: cleanText(values.notes, 3000),
      };
    },
    renderCard: (record) => recordCard(record.title, {
      eyebrow: record.category,
      badge: {
        label: record.status === 'paid' ? 'Paid' : record.status === 'autopay' ? 'Autopay' : 'Due',
        tone: record.status === 'paid' ? 'ok' : record.status === 'autopay' ? 'info' : 'warn',
      },
      meta: [formatMoney(record.amountCents), record.dueDate && formatDate(`${record.dueDate}T12:00:00`), record.frequency].filter(Boolean),
      body: record.notes,
    }),
    actions: (record) => record.status !== 'paid' && el('button', {
      class: 'btn btn--small', type: 'button', onClick: async () => {
        try {
          await saveRecord(RECORD_COLLECTIONS.expenses, record.id, {
            status: 'paid', paidAt: new Date().toISOString(),
          });
          toast('Marked paid');
        } catch { toast('Could not update', { error: true }); }
      },
    }, 'Mark paid'),
    deletePrompt: (record) => `Delete “${record.title}”?`,
  });
}

export async function budgetView() {
  const selectedMonth = el('input', { class: 'input', type: 'month', value: monthKey() });
  const summaryNode = el('div', {}, spinner('Loading budget…'));
  const list = el('div');
  const month = el('input', { class: 'input', type: 'month', required: true, value: monthKey() });
  const category = el('select', { class: 'input', required: true },
    el('option', { value: '' }, 'Choose a category'),
    MONEY_CATEGORIES.map((name) => el('option', { value: name }, name)),
  );
  const amount = el('input', { class: 'input', type: 'number', required: true, min: '0', step: '0.01', placeholder: '0.00' });
  const save = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Add category');
  const form = el('form', { class: 'record-form' },
    el('div', { class: 'row' },
      el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Month'), month),
      el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Category'), category),
    ),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Planned amount'), amount),
    el('div', { class: 'row row--end' }, save),
  );
  let budgets = [];
  let expenses = [];

  const paint = () => {
    const data = budgetSummary(budgets, expenses, selectedMonth.value || monthKey());
    summaryNode.replaceChildren(
      el('div', { class: 'budget-totals' },
        stat('Planned', data.plannedCents), stat('Recorded', data.recordedCents),
        stat(data.remainingCents < 0 ? 'Over' : 'Remaining', Math.abs(data.remainingCents), data.remainingCents < 0),
      ),
    );
    list.replaceChildren(
      data.categories.length === 0
        ? emptyState('📊', 'No budget for this month', 'Add a category and planned amount above.')
        : el('div', { class: 'record-list' }, data.categories.map((item) => {
          const source = budgets.find((budget) => budget.month === data.month && budget.category === item.category);
          const card = recordCard(item.category, {
            meta: [`Planned ${formatMoney(item.plannedCents)}`, `Recorded ${formatMoney(item.recordedCents)}`],
            badge: {
              label: item.remainingCents < 0 ? `${formatMoney(Math.abs(item.remainingCents))} over` : `${formatMoney(item.remainingCents)} left`,
              tone: item.remainingCents < 0 ? 'warn' : 'ok',
            },
          });
          if (source?.createdBy === state.user?.uid) card.append(el('div', { class: 'record-actions' },
            el('button', { class: 'link-btn link-btn--danger', type: 'button', onClick: async () => {
              if (!confirm(`Remove the ${item.category} budget for ${data.month}?`)) return;
              try { await removeRecord(RECORD_COLLECTIONS.budgets, source.id); }
              catch { toast('Could not remove it', { error: true }); }
            } }, 'Delete'),
          ));
          return card;
        })),
    );
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const plannedCents = moneyToCents(amount.value);
    if (plannedCents == null) return toast('Enter a valid planned amount.', { error: true });
    const existing = budgets.find((item) => item.month === month.value && item.category === category.value);
    save.disabled = true;
    try {
      await saveRecord(RECORD_COLLECTIONS.budgets, existing?.id ?? null, {
        month: month.value, category: category.value, plannedCents,
      });
      selectedMonth.value = month.value;
      amount.value = '';
      toast(existing ? 'Budget updated' : 'Budget category added');
    } catch { toast('Could not save', { error: true }); }
    finally { save.disabled = false; }
  });
  selectedMonth.addEventListener('change', paint);

  const container = el('div', { class: 'view' },
    el('header', { class: 'view__header' },
      el('h1', {}, 'Shared budget'),
      el('p', { class: 'muted' }, 'Plan by category and compare it with bills and expenses recorded for the same month.'),
    ),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Viewing month'), selectedMonth),
    summaryNode,
    el('details', { class: 'card record-editor' }, el('summary', {}, 'Add or update a budget category'), form),
    list,
  );

  const stopBudget = watchRecords(RECORD_COLLECTIONS.budgets, { orderBy: ['month', 'desc'], limit: 500 }, (items) => { budgets = items; paint(); });
  const stopExpenses = watchRecords(RECORD_COLLECTIONS.expenses, { orderBy: ['dueDate', 'desc'], limit: 1000 }, (items) => { expenses = items; paint(); });
  container.addEventListener('fd:teardown', () => { stopBudget?.(); stopExpenses?.(); }, { once: true });
  return container;
}

function stat(label, cents, danger = false) {
  return el('div', { class: `budget-stat${danger ? ' budget-stat--danger' : ''}` },
    el('div', { class: 'budget-stat__value' }, formatMoney(cents)),
    el('div', { class: 'muted small' }, label),
  );
}
