/** Shared, mobile-first record editor used by the care and money screens. */

import { el, emptyState, spinner, toast, children } from '../ui.js';
import { removeRecord, saveRecord, watchRecords } from '../records.js';
import { state } from '../store.js';

function inputFor(field, context) {
  const options = typeof field.options === 'function' ? field.options(context) : field.options;
  let input;
  if (options) {
    input = el('select', { class: 'input', name: field.key },
      field.placeholder != null && el('option', { value: '' }, field.placeholder),
      options.map((option) => {
        const item = typeof option === 'string' ? { value: option, label: option } : option;
        return el('option', { value: item.value }, item.label);
      }),
    );
  } else if (field.type === 'textarea') {
    input = el('textarea', {
      class: 'input', name: field.key, rows: field.rows ?? 3,
      placeholder: field.placeholder ?? '', maxlength: field.maxlength ?? 4000,
    });
  } else if (field.type === 'checkbox') {
    input = el('input', { name: field.key, type: 'checkbox' });
  } else {
    input = el('input', {
      class: 'input', name: field.key, type: field.type ?? 'text',
      placeholder: field.placeholder ?? '', min: field.min, max: field.max,
      step: field.step, maxlength: field.maxlength ?? 300,
    });
  }
  if (field.required) input.required = true;

  if (field.type === 'checkbox') {
    return el('label', { class: 'record-check' }, input, el('span', {}, field.label));
  }
  return el('label', { class: `field${field.inline ? ' field--inline' : ''}` },
    el('span', { class: 'field__label' }, field.label),
    field.hint && el('span', { class: 'field__hint' }, field.hint),
    input,
  );
}

function readForm(form, fields) {
  const values = {};
  for (const field of fields) {
    const input = form.elements.namedItem(field.key);
    values[field.key] = field.type === 'checkbox' ? Boolean(input?.checked) : String(input?.value ?? '').trim();
  }
  return values;
}

function fillForm(form, fields, record = null) {
  for (const field of fields) {
    const input = form.elements.namedItem(field.key);
    if (!input) continue;
    const raw = record
      ? (field.fromRecord ? field.fromRecord(record) : record[field.key])
      : (typeof field.defaultValue === 'function' ? field.defaultValue() : field.defaultValue);
    if (field.type === 'checkbox') input.checked = Boolean(raw);
    else input.value = raw ?? '';
  }
}

/**
 * Builds a complete CRUD screen around one Firestore collection.
 * Special modules can add summaries and actions while keeping consistent forms,
 * empty states, edit/delete behavior, live updates, and teardown.
 */
export async function collectionView(config) {
  const context = await config.loadContext?.() ?? {};
  const list = el('div', {}, spinner('Loading…'));
  const summary = el('div');
  const details = el('details', { class: 'card record-editor' });
  const summaryLabel = el('span', {}, config.addLabel ?? `Add ${config.singular.toLowerCase()}`);
  const form = el('form', { class: 'record-form' },
    config.fields.map((field) => inputFor(field, context)),
  );
  const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
  const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Save');
  form.append(el('div', { class: 'row row--end' }, cancel, submit));
  details.append(el('summary', {}, summaryLabel), form);

  let editing = null;
  let records = [];

  const resetEditor = () => {
    editing = null;
    summaryLabel.textContent = config.addLabel ?? `Add ${config.singular.toLowerCase()}`;
    submit.textContent = 'Save';
    fillForm(form, config.fields);
  };

  cancel.addEventListener('click', () => {
    resetEditor();
    details.open = false;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = readForm(form, config.fields);
    const outcome = config.toRecord(values, editing, context);
    if (outcome?.error) return toast(outcome.error, { error: true });

    submit.disabled = true;
    try {
      await saveRecord(config.collection, editing?.id ?? null, outcome);
      toast(editing ? 'Changes saved' : `${config.singular} added`);
      resetEditor();
      details.open = false;
    } catch {
      toast('Could not save. Check your connection.', { error: true });
    } finally {
      submit.disabled = false;
    }
  });

  const edit = (record) => {
    editing = record;
    summaryLabel.textContent = `Edit ${config.singular.toLowerCase()}`;
    submit.textContent = 'Save changes';
    fillForm(form, config.fields, record);
    details.open = true;
    details.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const remove = async (record) => {
    if (!confirm(config.deletePrompt?.(record) ?? `Delete this ${config.singular.toLowerCase()}?`)) return;
    try {
      await removeRecord(config.collection, record.id);
      toast('Deleted');
    } catch {
      toast('Could not delete', { error: true });
    }
  };

  const paint = () => {
    const ordered = config.sort ? [...records].sort(config.sort) : records;
    summary.replaceChildren(...children(config.renderSummary?.(ordered, context)));
    list.replaceChildren(
      ordered.length === 0
        ? emptyState(config.icon, config.emptyTitle, config.emptyMessage)
        : el('div', { class: 'record-list' }, ordered.map((record) => {
          const card = config.renderCard(record, context);
          const custom = config.actions?.(record, { repaint: paint, context }) ?? [];
          const canDelete = record.createdBy && record.createdBy === state.user?.uid;
          card.append(el('div', { class: 'record-actions' },
            ...children(custom),
            el('button', { class: 'link-btn', type: 'button', onClick: () => edit(record) }, 'Edit'),
            canDelete && el('button', { class: 'link-btn link-btn--danger', type: 'button', onClick: () => remove(record) }, 'Delete'),
          ));
          return card;
        })),
    );
  };

  resetEditor();
  const container = el('div', { class: 'view' },
    el('header', { class: 'view__header' },
      el('h1', {}, config.title),
      config.intro && el('p', { class: 'muted' }, config.intro),
    ),
    config.notice,
    summary,
    details,
    list,
  );

  const unsubscribe = watchRecords(config.collection, config.query ?? {}, (next) => {
    records = next;
    paint();
  });
  container.addEventListener('fd:teardown', () => unsubscribe?.(), { once: true });
  return container;
}

export function recordCard(title, { eyebrow = null, meta = [], body = null, badge = null } = {}) {
  return el('article', { class: 'card record-card' },
    el('div', { class: 'record-card__head' },
      el('div', {},
        eyebrow && el('div', { class: 'record-card__eyebrow' }, eyebrow),
        el('h2', {}, title || 'Untitled'),
      ),
      badge && el('span', { class: `record-badge record-badge--${badge.tone ?? 'neutral'}` }, badge.label),
    ),
    meta.length > 0 && el('div', { class: 'record-meta' }, meta.map((item) => el('span', {}, item))),
    body && el('p', { class: 'record-card__body' }, body),
  );
}

export function sortNewest(field = 'createdAt') {
  return (a, b) => String(b[field] ?? '').localeCompare(String(a[field] ?? ''));
}

export function sortSoonest(field) {
  return (a, b) => String(a[field] ?? '9999').localeCompare(String(b[field] ?? '9999'));
}
