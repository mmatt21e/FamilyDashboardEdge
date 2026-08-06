/**
 * Message board and shared calendar.
 *
 * Both are small Firestore collections with a live subscription, since these
 * are the two places where seeing someone else's change arrive without a
 * refresh actually matters.
 */

import { el, spinner, emptyState, toast, relativeTime, formatDate } from '../ui.js';
import { state } from '../store.js';
import * as fb from '../firebase.js';
import { RECORD_COLLECTIONS, removeRecord, saveRecord } from '../records.js';

// ---------------------------------------------------------------------------
// Message board
// ---------------------------------------------------------------------------

export async function feedView() {
  const list = el('div', { class: 'feed' }, spinner('Loading…'));
  let messages = [];
  let comments = [];
  const commentDrafts = new Map();
  const textarea = el('textarea', {
    class: 'input', rows: 3, maxlength: 2000,
    placeholder: 'Share something with the family…',
  });
  const post = el('button', { class: 'btn btn--primary' }, 'Post');

  post.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body) return;
    post.disabled = true;
    try {
      await fb.addDoc('messages', {
        body,
        authorId: state.user?.uid ?? null,
        authorName: state.member?.name ?? 'Someone',
        authorPhoto: state.member?.photoURL ?? null,
        createdAt: new Date().toISOString(),
      });
      textarea.value = '';
      toast('Posted');
    } catch {
      toast('Could not post. Check your connection.', { error: true });
    } finally {
      post.disabled = false;
    }
  });

  const container = el('div', { class: 'view' },
    el('header', { class: 'view__header' }, el('h1', {}, 'Message board')),
    el('div', { class: 'card' }, textarea, el('div', { class: 'row row--end' }, post)),
    list,
  );

  // Newest 50. A family board does not need infinite scroll, and a bounded
  // query keeps the Firestore free tier comfortable.
  const paint = () => {
    list.replaceChildren(
      messages.length === 0
        ? emptyState('💬', 'Nothing yet', 'Be the first to say something.')
        : el('div', {}, messages.map((message) => messageCard(
            message,
            comments.filter((comment) => comment.targetType === 'message' && comment.targetId === message.id),
            commentDrafts,
          ))),
    );
  };

  const unsubscribe = fb.watchDocs(
    'messages',
    { orderBy: ['createdAt', 'desc'], limit: 50 },
    (next) => { messages = next; paint(); },
  );
  const stopComments = fb.watchDocs(
    RECORD_COLLECTIONS.familyItems,
    { where: [['moduleKey', '==', 'comments']], limit: 500 },
    (next) => { comments = next; paint(); },
  );
  container.addEventListener('fd:teardown', () => { unsubscribe?.(); stopComments?.(); }, { once: true });

  return container;
}

function messageCard(message, comments = [], drafts = new Map()) {
  const canDelete = message.authorId && message.authorId === state.user?.uid;

  const remove = canDelete && el('button', { class: 'link-btn', title: 'Delete' }, 'Delete');
  remove?.addEventListener('click', async () => {
    if (!confirm('Delete this post?')) return;
    try { await fb.deleteDoc('messages', message.id); }
    catch { toast('Could not delete', { error: true }); }
  });

  return el('article', { class: 'card message' },
    el('div', { class: 'message__head' },
      message.authorPhoto
        ? el('img', { class: 'avatar', src: message.authorPhoto, alt: '', loading: 'lazy' })
        : el('div', { class: 'avatar avatar--letter' }, (message.authorName ?? '?')[0]),
      el('div', {},
        el('div', { class: 'message__author' }, message.authorName ?? 'Someone'),
        el('div', { class: 'muted small' }, relativeTime(message.createdAt)),
      ),
      remove,
    ),
    el('p', { class: 'message__body' }, message.body ?? ''),
    commentThread(message, comments, drafts),
  );
}

function commentThread(message, comments, drafts) {
  const input = el('textarea', {
    class: 'input comment-thread__input', rows: 2, maxlength: 1200,
    placeholder: 'Reply to this post…', 'aria-label': `Reply to ${message.authorName ?? 'this post'}`,
  });
  input.value = drafts.get(message.id) ?? '';
  input.addEventListener('input', () => drafts.set(message.id, input.value));
  const send = el('button', { class: 'btn btn--small', type: 'button' }, 'Reply');
  send.addEventListener('click', async () => {
    const body = input.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      await saveRecord(RECORD_COLLECTIONS.familyItems, null, {
        moduleKey: 'comments', targetType: 'message', targetId: message.id,
        subject: `Reply to ${message.authorName ?? 'a family post'}`, body,
      });
      input.value = '';
      drafts.delete(message.id);
      toast('Reply added');
    } catch { toast('Could not add the reply', { error: true }); }
    finally { send.disabled = false; }
  });

  return el('section', { class: 'comment-thread', 'aria-label': 'Comments' },
    comments.length > 0 && el('div', { class: 'comment-thread__list' },
      comments.map((comment) => el('div', { class: 'comment-thread__comment' },
        el('div', { class: 'row row--between' },
          el('strong', { class: 'small' }, comment.createdByName ?? 'Someone'),
          el('span', { class: 'muted small' }, relativeTime(comment.createdAt)),
        ),
        el('p', {}, comment.body),
        comment.createdBy === state.user?.uid && el('button', {
          class: 'link-btn link-btn--danger', type: 'button', onClick: async () => {
            if (!confirm('Delete this reply?')) return;
            try { await removeRecord(RECORD_COLLECTIONS.familyItems, comment.id); }
            catch { toast('Could not delete the reply', { error: true }); }
          },
        }, 'Delete'),
      )),
    ),
    el('div', { class: 'comment-thread__form' }, input, send),
  );
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/**
 * Leans towards "when are we seeing each other" rather than being a full
 * calendar: upcoming events as a list, with whole-day entries, because visits
 * and trips are the thing this family actually coordinates.
 */
export async function calendarView() {
  const list = el('div', {}, spinner('Loading…'));

  const title = el('input', { class: 'input', placeholder: 'What is happening?' });
  const start = el('input', { class: 'input', type: 'date' });
  const end = el('input', { class: 'input', type: 'date' });
  const add = el('button', { class: 'btn btn--primary' }, 'Add');

  add.addEventListener('click', async () => {
    const name = title.value.trim();
    if (!name) return toast('Give it a name first', { error: true });
    if (!start.value) return toast('Pick a start date', { error: true });
    if (end.value && end.value < start.value) {
      return toast('The end date is before the start date', { error: true });
    }

    add.disabled = true;
    try {
      await fb.addDoc('calendar_events', {
        title: name,
        start: start.value,
        end: end.value || start.value,
        createdBy: state.user?.uid ?? null,
        createdByName: state.member?.name ?? 'Someone',
        createdAt: new Date().toISOString(),
      });
      title.value = ''; start.value = ''; end.value = '';
      toast('Added to the calendar');
    } catch {
      toast('Could not save', { error: true });
    } finally {
      add.disabled = false;
    }
  });

  const container = el('div', { class: 'view' },
    el('header', { class: 'view__header' }, el('h1', {}, 'Calendar')),
    el('details', { class: 'card' },
      el('summary', {}, 'Add something'),
      title,
      el('div', { class: 'row' },
        el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'From'), start),
        el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'To'), end),
      ),
      el('div', { class: 'row row--end' }, add),
    ),
    list,
  );

  const unsubscribe = fb.watchDocs(
    'calendar_events',
    { orderBy: ['start', 'asc'], limit: 200 },
    (events) => {
      // Filtered client-side: Firestore would need a composite index to do
      // "end >= today ordered by start", and this list is small enough that it
      // is not worth making the family create one in the console.
      const today = new Date().toISOString().slice(0, 10);
      const upcoming = events.filter((event) => (event.end ?? event.start) >= today);

      list.replaceChildren(
        upcoming.length === 0
          ? emptyState('📅', 'Nothing planned', 'Add a visit, a trip, or the next time everyone is together.')
          : el('div', {}, upcoming.map(eventCard)),
      );
    },
  );
  container.addEventListener('fd:teardown', () => unsubscribe?.(), { once: true });

  return container;
}

function eventCard(event) {
  const startDate = new Date(`${event.start}T00:00:00`);
  const days = Math.ceil((startDate - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const countdown = days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : `in ${days} days`;

  const canDelete = event.createdBy && event.createdBy === state.user?.uid;
  const remove = canDelete && el('button', { class: 'link-btn' }, 'Delete');
  remove?.addEventListener('click', async () => {
    if (!confirm(`Delete "${event.title}"?`)) return;
    try { await fb.deleteDoc('calendar_events', event.id); }
    catch { toast('Could not delete', { error: true }); }
  });

  const range = event.end && event.end !== event.start
    ? `${formatDate(event.start)} – ${formatDate(event.end)}`
    : formatDate(event.start);

  return el('article', { class: 'card event' },
    el('div', { class: 'event__when' }, el('strong', {}, countdown)),
    el('div', { class: 'event__body' },
      el('div', { class: 'event__title' }, event.title),
      el('div', { class: 'muted small' }, range),
    ),
    remove,
  );
}
