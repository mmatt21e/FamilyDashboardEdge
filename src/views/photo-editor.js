/**
 * Correcting a photo's tags by hand.
 *
 * One form, used in two places: on a photo you are looking at, and on a batch
 * you are about to upload. Tagging at upload time matters more than it sounds -
 * it is the only moment when someone definitely knows what they are looking at,
 * and a photo tagged then never needs correcting later.
 *
 * The form reports what it holds rather than saving anything itself, so the
 * viewer can write one correction and the upload flow can apply the same
 * answers to twenty files without the form knowing the difference.
 */

import { el, children } from '../ui.js';
import {
  addPerson, removePerson, normalisePersonName,
  toDateInput, toTimeInput, fromDateInput, parseEventInput,
} from '../photo-edits.js';

const NEW_EVENT = '__new__';

/**
 * Builds the form.
 *
 * @param {object} options
 * @param {{people?: string[], event?: object|null, takenAt?: string|null}} options.initial
 * @param {string[]} options.knownPeople   names already in use, offered as suggestions
 * @param {Array<{value: string, label: string, category: string|null}>} options.knownEvents
 * @param {boolean} options.allowClearDate hidden for uploads, where there is no date yet
 * @returns {{node: Node, read: () => object}}
 */
export function tagForm({ initial = {}, knownPeople = [], knownEvents = [], allowClearDate = true } = {}) {
  let people = [...(initial.people ?? [])];
  let event = initial.event ?? null;
  let takenAt = initial.takenAt ?? null;

  // --- people ---------------------------------------------------------------
  const chips = el('div', { class: 'chips chips--tight' });

  const drawChips = () => {
    chips.replaceChildren(...children(
      people.map((person) => {
        const chip = el('button', {
          class: 'chip chip--active', type: 'button', 'aria-label': `Remove ${person}`,
        }, person, el('span', { class: 'chip__x' }, '✕'));
        chip.addEventListener('click', () => {
          people = removePerson(people, person);
          drawChips();
        });
        return chip;
      }),
      people.length === 0 && el('span', { class: 'muted small' }, 'Nobody tagged yet'),
    ));
  };
  drawChips();

  // A datalist rather than a dropdown: the family names come up as suggestions
  // after a letter or two, but a name that has never been used before can still
  // just be typed. Both have to work - photos arrive with new people in them.
  const listId = `people-${Math.random().toString(36).slice(2, 8)}`;
  const suggestions = el('datalist', { id: listId },
    knownPeople.map((name) => el('option', { value: name })));

  const nameInput = el('input', {
    class: 'input', type: 'text', list: listId, placeholder: 'Add a person',
    autocomplete: 'off', 'aria-label': 'Add a person',
  });
  const addButton = el('button', { class: 'btn', type: 'button' }, 'Add');

  const commitName = () => {
    const name = normalisePersonName(nameInput.value, knownPeople);
    if (!name) return;
    people = addPerson(people, name);
    nameInput.value = '';
    drawChips();
  };
  addButton.addEventListener('click', commitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitName(); }
  });
  // Picking from the suggestion list fires input, not keydown, on most browsers.
  nameInput.addEventListener('change', () => { if (nameInput.value) commitName(); });

  // --- event ----------------------------------------------------------------
  const newEvent = el('input', {
    class: 'input', type: 'text', placeholder: 'Trips / Isle of Skye', hidden: true,
    'aria-label': 'New event name',
  });

  const eventSelect = el('select', { class: 'input', 'aria-label': 'Event' },
    el('option', { value: '' }, 'No event'),
    knownEvents.map((known) => el('option', {
      value: known.value,
      selected: known.value === event?.id || undefined,
    }, known.category ? `${known.category}: ${known.label}` : known.label)),
    el('option', { value: NEW_EVENT }, 'New event…'),
  );

  // An event the photo already has but that no longer appears in the library -
  // the last photo of it was filtered out, say - would otherwise be silently
  // dropped on save.
  if (event?.id && !knownEvents.some((known) => known.value === event.id)) {
    eventSelect.insertBefore(
      el('option', { value: event.id, selected: true }, event.category ? `${event.category}: ${event.name}` : event.name),
      eventSelect.lastElementChild,
    );
  }

  eventSelect.addEventListener('change', () => {
    const isNew = eventSelect.value === NEW_EVENT;
    newEvent.hidden = !isNew;
    if (isNew) newEvent.focus();
  });

  // --- date -----------------------------------------------------------------
  const dateInput = el('input', { class: 'input', type: 'date', value: toDateInput(takenAt), 'aria-label': 'Date taken' });
  const timeInput = el('input', { class: 'input', type: 'time', value: toTimeInput(takenAt), 'aria-label': 'Time taken' });
  const dateNote = el('div', { class: 'muted small' });

  const drawDateNote = () => {
    dateNote.textContent = dateInput.value
      ? 'Used for the year and month filters, and for Memories.'
      : 'With no date this photo is left out of the year and month filters, and never appears in Memories.';
  };
  drawDateNote();
  dateInput.addEventListener('input', drawDateNote);

  const clearDate = el('button', { class: 'btn btn--danger', type: 'button' }, 'Clear the date');
  clearDate.addEventListener('click', () => {
    dateInput.value = '';
    timeInput.value = '';
    drawDateNote();
  });

  // --- the form -------------------------------------------------------------
  const node = el('div', { class: 'tag-form' },
    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Who is in this photo'),
      chips,
      el('div', { class: 'row' }, nameInput, suggestions, addButton),
    ),

    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Event'),
      eventSelect,
      newEvent,
      el('span', { class: 'field__hint' },
        'A name on its own is fine. "Trips / Vegas" files it under Trips.'),
    ),

    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Date taken'),
      el('div', { class: 'row' }, dateInput, timeInput, allowClearDate && clearDate),
      dateNote,
    ),
  );

  /** What the form currently holds, in the shape the store expects. */
  function read() {
    let chosenEvent = null;
    if (eventSelect.value === NEW_EVENT) {
      chosenEvent = parseEventInput(newEvent.value);
    } else if (eventSelect.value) {
      const known = knownEvents.find((k) => k.value === eventSelect.value);
      chosenEvent = known
        ? { id: known.value, name: known.label, category: known.category ?? null }
        : (event?.id === eventSelect.value ? event : null);
    }

    return {
      people: [...people],
      event: chosenEvent,
      takenAt: dateInput.value ? fromDateInput(dateInput.value, timeInput.value) : null,
    };
  }

  return { node, read };
}

/**
 * Puts the form in a sheet over whatever is on screen.
 *
 * Resolves with the form's values, or null if it was cancelled - so a caller
 * reads as one straight line rather than a knot of callbacks.
 *
 * @returns {Promise<object|null>}
 */
export function openTagSheet({
  title, subtitle = null, initial = {}, knownPeople = [], knownEvents = [],
  saveLabel = 'Save', allowClearDate = true, onReset = null,
}) {
  return new Promise((resolve) => {
    const form = tagForm({ initial, knownPeople, knownEvents, allowClearDate });

    const save = el('button', { class: 'btn btn--primary', type: 'button' }, saveLabel);
    const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
    const reset = onReset && el('button', { class: 'btn btn--danger', type: 'button' }, 'Undo my corrections');

    const sheet = el('div', { class: 'sheet__panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('header', { class: 'sheet__head' },
        el('h2', {}, title),
        subtitle && el('p', { class: 'muted small' }, subtitle),
      ),
      form.node,
      el('div', { class: 'row row--between sheet__foot' },
        el('div', { class: 'row' }, cancel, save),
        reset,
      ),
    );

    const overlay = el('div', { class: 'sheet' }, sheet);

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (event) => { if (event.key === 'Escape') close(null); };

    save.addEventListener('click', () => close(form.read()));
    cancel.addEventListener('click', () => close(null));
    reset?.addEventListener('click', () => { close(null); onReset(); });

    // Clicking the backdrop cancels; clicking inside the panel must not.
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);

    document.body.append(overlay);
    sheet.querySelector('input')?.focus();
  });
}
