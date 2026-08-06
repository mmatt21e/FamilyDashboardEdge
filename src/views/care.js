/** Care modules: shared reference information and day-to-day coordination. */

import { el, emptyState, formatDate, relativeTime, spinner, toast } from '../ui.js';
import { state } from '../store.js';
import {
  RECORD_COLLECTIONS, cleanText, familyMemberNames, removeRecord, saveRecord,
  todayKey, watchRecords, wellnessForDay,
} from '../records.js';
import { collectionView, recordCard, sortNewest, sortSoonest } from './records.js';

async function peopleContext() {
  let people = [];
  try { people = await familyMemberNames(); } catch { /* cached member below is enough offline */ }
  const current = cleanText(state.member?.name || state.user?.email, 120);
  if (current && !people.includes(current)) people.push(current);
  people.sort((a, b) => a.localeCompare(b));
  return { people, current };
}

const personField = (label = 'Family member') => ({
  key: 'person', label, required: true, placeholder: 'Choose a person',
  options: ({ people }) => people,
  defaultValue: () => cleanText(state.member?.name || state.user?.email, 120),
});

function medicalNotice() {
  return el('div', { class: 'card record-notice record-notice--care' },
    el('strong', {}, 'Reference information only'),
    el('p', { class: 'small' },
      'This dashboard cannot diagnose, monitor emergencies, or replace a doctor. Call emergency services for urgent help and verify medication instructions with a clinician.'),
  );
}

export function medicalInfoView() {
  return collectionView({
    title: 'Medical info', singular: 'Medical profile', icon: '🩺',
    collection: RECORD_COLLECTIONS.medicalInfo,
    intro: 'Important health details the family may need when helping one another.',
    notice: medicalNotice(),
    addLabel: 'Add a medical profile',
    emptyTitle: 'No medical profiles yet',
    emptyMessage: 'Add allergies, doctors, insurance, and emergency details for a family member.',
    query: { orderBy: ['updatedAt', 'desc'], limit: 200 },
    sort: (a, b) => String(a.person).localeCompare(String(b.person)),
    loadContext: peopleContext,
    fields: [
      personField(),
      { key: 'allergies', label: 'Allergies', type: 'textarea', rows: 2, placeholder: 'Medicine, food, or environmental allergies' },
      { key: 'conditions', label: 'Conditions', type: 'textarea', rows: 2, placeholder: 'Relevant diagnoses or ongoing conditions' },
      { key: 'doctors', label: 'Doctors and care team', type: 'textarea', rows: 2, placeholder: 'Name, specialty, and safe contact details' },
      { key: 'insurance', label: 'Insurance', placeholder: 'Provider and safe member reference' },
      { key: 'emergencyContact', label: 'Emergency contact', placeholder: 'Name and phone number' },
      { key: 'notes', label: 'Other important notes', type: 'textarea', placeholder: 'Accessibility, communication, or care preferences' },
    ],
    toRecord: (values) => ({
      person: cleanText(values.person, 120), allergies: cleanText(values.allergies, 2000),
      conditions: cleanText(values.conditions, 2000), doctors: cleanText(values.doctors, 2000),
      insurance: cleanText(values.insurance, 300), emergencyContact: cleanText(values.emergencyContact, 300),
      notes: cleanText(values.notes, 3000),
    }),
    renderCard: (record) => recordCard(record.person, {
      eyebrow: 'Medical profile',
      meta: [record.insurance, record.emergencyContact].filter(Boolean),
      body: [
        record.allergies && `Allergies: ${record.allergies}`,
        record.conditions && `Conditions: ${record.conditions}`,
        record.doctors && `Care team: ${record.doctors}`,
        record.notes,
      ].filter(Boolean).join('\n'),
    }),
    deletePrompt: (record) => `Delete ${record.person}’s medical profile?`,
  });
}

export async function medicationsView() {
  const recent = el('div', { class: 'card' }, el('h2', {}, 'Recent doses'), spinner('Loading…'));
  const view = await collectionView({
    title: 'Medications', singular: 'Medication', icon: '💊',
    collection: RECORD_COLLECTIONS.medications,
    intro: 'Keep the current medication list together and record when a dose was taken.',
    notice: medicalNotice(),
    addLabel: 'Add a medication',
    emptyTitle: 'No medications listed',
    emptyMessage: 'Add a current medication and its instructions.',
    query: { orderBy: ['updatedAt', 'desc'], limit: 300 },
    sort: (a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || String(a.person).localeCompare(String(b.person)),
    loadContext: peopleContext,
    fields: [
      personField(),
      { key: 'name', label: 'Medication', required: true, placeholder: 'Name on the label' },
      { key: 'dose', label: 'Dose', required: true, placeholder: '10 mg, one tablet' },
      { key: 'schedule', label: 'Schedule', required: true, placeholder: 'Every morning with food' },
      { key: 'purpose', label: 'Purpose', placeholder: 'What it is for' },
      { key: 'prescriber', label: 'Prescriber or pharmacy', placeholder: 'Safe contact reference' },
      { key: 'refillDate', label: 'Refill date', type: 'date' },
      { key: 'notes', label: 'Instructions and notes', type: 'textarea', placeholder: 'Use the exact directions from the label' },
      { key: 'active', label: 'Currently taking this medication', type: 'checkbox', defaultValue: true },
    ],
    toRecord: (values) => ({
      person: cleanText(values.person, 120), name: cleanText(values.name, 160),
      dose: cleanText(values.dose, 200), schedule: cleanText(values.schedule, 300),
      purpose: cleanText(values.purpose, 300), prescriber: cleanText(values.prescriber, 300),
      refillDate: values.refillDate || null, notes: cleanText(values.notes, 3000), active: values.active,
    }),
    renderCard: (record) => recordCard(record.name, {
      eyebrow: record.person,
      badge: { label: record.active ? 'Active' : 'Inactive', tone: record.active ? 'ok' : 'neutral' },
      meta: [record.dose, record.schedule, record.refillDate && `Refill ${friendlyDay(record.refillDate)}`].filter(Boolean),
      body: [record.purpose, record.prescriber && `Contact: ${record.prescriber}`, record.notes].filter(Boolean).join('\n'),
    }),
    actions: (record) => record.active && el('button', {
      class: 'btn btn--small', type: 'button', onClick: async () => {
        try {
          await saveRecord(RECORD_COLLECTIONS.medicationLogs, null, {
            medicationId: record.id, medicationName: record.name, person: record.person,
            dose: record.dose, takenAt: new Date().toISOString(),
          });
          toast(`Dose recorded for ${record.person}`);
        } catch { toast('Could not record the dose', { error: true }); }
      },
    }, 'Record dose'),
    deletePrompt: (record) => `Delete ${record.name} from ${record.person}’s medication list? Dose history is kept.`,
  });

  view.append(recent);
  const stopLogs = watchRecords(RECORD_COLLECTIONS.medicationLogs, { orderBy: ['takenAt', 'desc'], limit: 20 }, (logs) => {
    recent.replaceChildren(
      el('h2', {}, 'Recent doses'),
      logs.length === 0
        ? el('p', { class: 'muted small' }, 'No doses have been recorded yet.')
        : el('div', { class: 'compact-list' }, logs.map((log) => el('div', { class: 'compact-list__row' },
          el('span', {}, `${log.person}: ${log.medicationName} ${log.dose || ''}`),
          el('span', { class: 'muted small' }, relativeTime(log.takenAt)),
        ))),
    );
  });
  view.addEventListener('fd:teardown', () => stopLogs?.(), { once: true });
  return view;
}

export function appointmentsView() {
  return collectionView({
    title: 'Appointments', singular: 'Appointment', icon: '📋',
    collection: RECORD_COLLECTIONS.appointments,
    intro: 'Coordinate upcoming medical, dental, therapy, and care appointments.',
    addLabel: 'Add an appointment',
    emptyTitle: 'No appointments listed',
    emptyMessage: 'Add the next appointment so the family knows when and where it is.',
    query: { orderBy: ['startsAt', 'asc'], limit: 400 },
    sort: sortSoonest('startsAt'),
    loadContext: peopleContext,
    fields: [
      personField(),
      { key: 'title', label: 'Appointment', required: true, placeholder: 'Annual check-up' },
      { key: 'startsAt', label: 'Date and time', type: 'datetime-local', required: true },
      { key: 'provider', label: 'Provider', placeholder: 'Doctor, clinic, dentist, therapist' },
      { key: 'location', label: 'Location or call link', placeholder: 'Address, office, or video visit' },
      { key: 'transport', label: 'Transport or companion', placeholder: 'Who is driving or going along?' },
      { key: 'notes', label: 'Preparation and notes', type: 'textarea', placeholder: 'Questions, fasting instructions, paperwork' },
      { key: 'completed', label: 'Appointment completed', type: 'checkbox' },
    ],
    toRecord: (values) => ({
      person: cleanText(values.person, 120), title: cleanText(values.title, 160),
      startsAt: values.startsAt, provider: cleanText(values.provider, 200),
      location: cleanText(values.location, 500), transport: cleanText(values.transport, 300),
      notes: cleanText(values.notes, 3000), completed: values.completed,
    }),
    renderCard: (record) => recordCard(record.title, {
      eyebrow: record.person,
      badge: { label: record.completed ? 'Completed' : 'Upcoming', tone: record.completed ? 'ok' : 'info' },
      meta: [friendlyDateTime(record.startsAt), record.provider, record.location].filter(Boolean),
      body: [record.transport && `Transport: ${record.transport}`, record.notes].filter(Boolean).join('\n'),
    }),
    actions: (record) => !record.completed && el('button', {
      class: 'btn btn--small', type: 'button', onClick: async () => {
        try { await saveRecord(RECORD_COLLECTIONS.appointments, record.id, { completed: true }); toast('Marked completed'); }
        catch { toast('Could not update', { error: true }); }
      },
    }, 'Mark completed'),
    deletePrompt: (record) => `Delete “${record.title}” for ${record.person}?`,
  });
}

export function careLogView() {
  return collectionView({
    title: 'Care log', singular: 'Care note', icon: '📝',
    collection: RECORD_COLLECTIONS.careLogs,
    intro: 'A shared handoff log for family members coordinating care.',
    addLabel: 'Add a care note',
    emptyTitle: 'The care log is empty',
    emptyMessage: 'Add a concise update after a visit, call, or change in care.',
    query: { orderBy: ['occurredAt', 'desc'], limit: 500 },
    sort: sortNewest('occurredAt'),
    loadContext: peopleContext,
    fields: [
      personField('Who is this about?'),
      { key: 'occurredAt', label: 'When', type: 'datetime-local', required: true, defaultValue: localDateTime },
      { key: 'category', label: 'Type', options: ['Update', 'Visit', 'Meal', 'Medication', 'Symptom', 'Call', 'Task', 'Other'], defaultValue: 'Update' },
      { key: 'note', label: 'What happened?', type: 'textarea', required: true, rows: 4, placeholder: 'Write the useful facts for the next person helping' },
      { key: 'followUp', label: 'Follow-up', placeholder: 'What needs to happen next, and who will do it?' },
    ],
    toRecord: (values) => ({
      person: cleanText(values.person, 120), occurredAt: values.occurredAt,
      category: cleanText(values.category, 80), note: cleanText(values.note, 4000),
      followUp: cleanText(values.followUp, 1000),
    }),
    renderCard: (record) => recordCard(record.category || 'Care update', {
      eyebrow: record.person,
      meta: [friendlyDateTime(record.occurredAt), record.createdByName && `Added by ${record.createdByName}`].filter(Boolean),
      body: [record.note, record.followUp && `Follow-up: ${record.followUp}`].filter(Boolean).join('\n'),
    }),
    deletePrompt: () => 'Delete this care note?',
  });
}

export async function wellnessView() {
  const context = await peopleContext();
  const person = el('select', { class: 'input', required: true },
    el('option', { value: '' }, 'Choose a person'),
    context.people.map((name) => el('option', { value: name }, name)),
  );
  person.value = context.current;
  const status = el('select', { class: 'input', required: true },
    el('option', { value: 'good' }, 'Doing well'),
    el('option', { value: 'needs-attention' }, 'Needs attention'),
    el('option', { value: 'not-well' }, 'Not feeling well'),
  );
  const note = el('textarea', { class: 'input', rows: 3, maxlength: 2000, placeholder: 'Optional note for the family' });
  const save = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Save today’s check-in');
  const today = el('div', {}, spinner('Loading today…'));
  const history = el('div');
  let checks = [];

  const paint = () => {
    const day = wellnessForDay(checks, context.people);
    today.replaceChildren(
      el('div', { class: 'wellness-grid' },
        day.completed.map((check) => wellnessPerson(check.person, check.status, check.note)),
        day.missing.map((name) => wellnessPerson(name, 'missing', 'No check-in yet today')),
      ),
    );
    history.replaceChildren(
      checks.length === 0
        ? emptyState('❤️', 'No wellness history yet', 'Use the form above for today’s first check-in.')
        : el('div', { class: 'record-list' }, checks.slice(0, 40).map((check) => {
          const card = recordCard(check.person, {
            eyebrow: check.day,
            badge: wellnessBadge(check.status),
            meta: [check.createdByName && `Checked by ${check.createdByName}`, relativeTime(check.createdAt)].filter(Boolean),
            body: check.note,
          });
          if (check.createdBy === state.user?.uid) card.append(el('div', { class: 'record-actions' },
            el('button', { class: 'link-btn link-btn--danger', type: 'button', onClick: async () => {
              if (!confirm('Delete this wellness check-in?')) return;
              try { await removeRecord(RECORD_COLLECTIONS.wellnessChecks, check.id); }
              catch { toast('Could not delete it', { error: true }); }
            } }, 'Delete'),
          ));
          return card;
        })),
    );
  };

  const form = el('form', { class: 'card record-form' },
    el('h2', {}, 'Today’s check-in'),
    el('div', { class: 'row' },
      el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Family member'), person),
      el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'How are they?'), status),
    ),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Note'), note),
    el('div', { class: 'row row--end' }, save),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const day = todayKey();
    const existing = checks.find((check) => check.day === day && check.person === person.value);
    save.disabled = true;
    try {
      await saveRecord(RECORD_COLLECTIONS.wellnessChecks, existing?.id ?? null, {
        person: person.value, day, status: status.value, note: cleanText(note.value, 2000),
      });
      note.value = '';
      toast(existing ? 'Today’s check-in updated' : 'Check-in saved');
    } catch { toast('Could not save the check-in', { error: true }); }
    finally { save.disabled = false; }
  });

  const container = el('div', { class: 'view' },
    el('header', { class: 'view__header' },
      el('h1', {}, 'Wellness check'),
      el('p', { class: 'muted' }, 'A simple daily family signal. Missing check-ins are highlighted here; external alerts still require notification delivery.'),
    ),
    medicalNotice(), form,
    el('section', {}, el('h2', {}, 'Today'), today),
    el('section', {}, el('h2', {}, 'Recent check-ins'), history),
  );
  const stop = watchRecords(RECORD_COLLECTIONS.wellnessChecks, { orderBy: ['createdAt', 'desc'], limit: 300 }, (items) => { checks = items; paint(); });
  container.addEventListener('fd:teardown', () => stop?.(), { once: true });
  return container;
}

function wellnessPerson(name, value, note) {
  const badge = wellnessBadge(value);
  return el('article', { class: `wellness-person wellness-person--${badge.tone}` },
    el('div', { class: 'row row--between' }, el('strong', {}, name), el('span', { class: `record-badge record-badge--${badge.tone}` }, badge.label)),
    note && el('p', { class: 'small' }, note),
  );
}

function wellnessBadge(value) {
  if (value === 'good') return { label: 'Doing well', tone: 'ok' };
  if (value === 'needs-attention') return { label: 'Needs attention', tone: 'warn' };
  if (value === 'not-well') return { label: 'Not well', tone: 'danger' };
  return { label: 'Missing', tone: 'neutral' };
}

function friendlyDay(value) {
  return value ? formatDate(`${value}T12:00:00`) : '';
}

function friendlyDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${formatDate(date)} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function localDateTime() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
