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
});

const ALLOWED_COLLECTIONS = new Set(Object.values(RECORD_COLLECTIONS));

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
  return fb.addDoc(collection, {
    ...data,
    createdAt: now,
    createdBy: state.user?.uid ?? null,
    createdByName: state.member?.name ?? 'Someone',
    ...audit,
  });
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
