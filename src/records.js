/**
 * Shared data helpers for the care and money modules.
 *
 * These records are deliberately kept in ordinary, flat Firestore collections.
 * This is a single-family app, so a tenant layer would only make the data harder
 * to inspect and recover later. Every write carries an author and timestamps so
 * a family member can tell where a record came from.
 */

import * as fb from './firebase.js';
import { state } from './store.js';
import { getModule } from './modules.js';
import { recordActivity } from './notifications.js';

export const RECORD_COLLECTIONS = Object.freeze({
  financialRecords: 'financial_records',
  expenses: 'expenses',
  budgets: 'budgets',
  medicalInfo: 'medical_info',
  medications: 'medications',
  medicationLogs: 'medication_logs',
  appointments: 'appointments',
  careLogs: 'care_logs',
  wellnessChecks: 'wellness_checks',
  familyItems: 'list_items',
});

const ALLOWED_COLLECTIONS = new Set(Object.values(RECORD_COLLECTIONS));

const CARE_ROUTES = Object.freeze({
  medical_info: 'medical',
  medications: 'medications',
  medication_logs: 'medications',
  appointments: 'appointments',
  care_logs: 'carelog',
  wellness_checks: 'wellness',
});

const MONEY_ROUTES = Object.freeze({
  financial_records: 'records',
  expenses: 'expenses',
  budgets: 'budget',
});

const CALENDAR_MODULES = new Set(['birthdays', 'countdown', 'visitplanner', 'availability']);
const CARE_MODULES = new Set(['checkin']);
const MONEY_MODULES = new Set(['allowance']);

function assertCollection(collection) {
  if (!ALLOWED_COLLECTIONS.has(collection)) {
    throw new Error(`Unknown family record collection: ${collection}`);
  }
}

export function cleanText(value, max = 2000) {
  return String(value ?? '').trim().replace(/\r\n?/g, '\n').slice(0, max);
}

/** Money is stored as integer cents so repeated edits never accumulate floats. */
export function moneyToCents(value) {
  if (value == null || String(value).trim() === '') return null;
  const amount = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

export function centsToInput(cents) {
  return Number.isInteger(cents) ? (cents / 100).toFixed(2) : '';
}

export function formatMoney(cents, currency = 'USD') {
  const amount = Number.isFinite(Number(cents)) ? Number(cents) / 100 : 0;
  return new Intl.NumberFormat(undefined, {
    style: 'currency', currency, maximumFractionDigits: 2,
  }).format(amount);
}

export function monthKey(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function todayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Totals used by Shared budget. Recorded expenses include paid and upcoming bills. */
export function budgetSummary(budgets = [], expenses = [], month = monthKey()) {
  const byCategory = new Map();
  const ensure = (category) => {
    const key = cleanText(category, 80) || 'Other';
    if (!byCategory.has(key)) byCategory.set(key, { category: key, plannedCents: 0, recordedCents: 0 });
    return byCategory.get(key);
  };

  for (const budget of budgets) {
    if (budget.month !== month) continue;
    ensure(budget.category).plannedCents += Number(budget.plannedCents) || 0;
  }
  for (const expense of expenses) {
    if (monthKey(expense.dueDate || expense.date) !== month) continue;
    ensure(expense.category).recordedCents += Number(expense.amountCents) || 0;
  }

  const categories = [...byCategory.values()]
    .map((item) => ({ ...item, remainingCents: item.plannedCents - item.recordedCents }))
    .sort((a, b) => a.category.localeCompare(b.category));
  const totals = categories.reduce((out, item) => ({
    plannedCents: out.plannedCents + item.plannedCents,
    recordedCents: out.recordedCents + item.recordedCents,
    remainingCents: out.remainingCents + item.remainingCents,
  }), { plannedCents: 0, recordedCents: 0, remainingCents: 0 });

  return { month, categories, ...totals };
}

/** One latest check per person for the requested day. */
export function wellnessForDay(checks = [], people = [], day = todayKey()) {
  const latest = new Map();
  for (const check of checks) {
    if (check.day !== day || !check.person) continue;
    const existing = latest.get(check.person);
    if (!existing || String(check.createdAt ?? '') > String(existing.createdAt ?? '')) {
      latest.set(check.person, check);
    }
  }
  const names = [...new Set(people.map((person) => cleanText(person, 120)).filter(Boolean))].sort();
  return {
    day,
    completed: names.filter((name) => latest.has(name)).map((name) => latest.get(name)),
    missing: names.filter((name) => !latest.has(name)),
  };
}

export async function saveRecord(collection, id, data) {
  assertCollection(collection);
  const now = new Date().toISOString();
  const audit = {
    updatedAt: now,
    updatedBy: state.user?.uid ?? null,
    updatedByName: state.member?.name ?? 'Someone',
  };

  if (id) {
    await fb.setDoc(collection, id, { ...data, ...audit });
    return id;
  }
  const recordId = await fb.addDoc(collection, {
    ...data,
    createdAt: now,
    createdBy: state.user?.uid ?? null,
    createdByName: state.member?.name ?? 'Someone',
    ...audit,
  });
  const activity = activityForRecord(collection, data, state.member?.name ?? 'Someone');
  void recordActivity({ ...activity, sourceId: recordId });
  return recordId;
}

/** Generic, lock-screen-safe activity copy for the record-based modules. */
export function activityForRecord(collection, data = {}, actorName = 'Someone') {
  if (CARE_ROUTES[collection]) {
    return {
      category: 'care', title: 'New care or wellness update',
      body: `${actorName} added a care or wellness update.`,
      url: `#/${CARE_ROUTES[collection]}`,
    };
  }
  if (MONEY_ROUTES[collection]) {
    return {
      category: 'money', title: 'New money update',
      body: `${actorName} added a money update.`,
      url: `#/${MONEY_ROUTES[collection]}`,
    };
  }

  const moduleKey = cleanText(data.moduleKey, 80) || 'family';
  const module = getModule(moduleKey);
  const category = moduleKey === 'comments'
    ? 'feed'
    : CALENDAR_MODULES.has(moduleKey)
      ? 'calendar'
      : CARE_MODULES.has(moduleKey)
        ? 'care'
        : MONEY_MODULES.has(moduleKey)
          ? 'money'
          : 'family';
  const route = moduleKey === 'comments' ? 'feed' : moduleKey;
  const label = module?.title ?? 'family activity';
  return {
    category,
    title: moduleKey === 'comments' ? 'New reply' : `New ${label.toLowerCase()} update`,
    body: moduleKey === 'comments'
      ? `${actorName} replied to a family post.`
      : `${actorName} added something to ${label}.`,
    url: `#/${route}`,
  };
}

export async function removeRecord(collection, id) {
  assertCollection(collection);
  return fb.deleteDoc(collection, id);
}

export function watchRecords(collection, options, callback) {
  assertCollection(collection);
  return fb.watchDocs(collection, options, callback);
}

export async function familyMemberNames() {
  const members = await fb.queryDocs('members');
  return [...new Set(members
    .map((member) => cleanText(member.name || member.email, 120))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}
