/** The remaining family modules, built on the shared audited record editor. */

import { el, formatDate, toast } from '../ui.js';
import {
  RECORD_COLLECTIONS, cleanText, familyMemberNames, saveRecord, todayKey,
} from '../records.js';
import { state } from '../store.js';
import { uploadFile } from '../drive.js';
import { collectionView, recordCard, sortNewest, sortSoonest } from './records.js';

const text = (key, label, placeholder = '', extra = {}) => ({ key, label, placeholder, ...extra });
const area = (key, label, placeholder = '', extra = {}) => ({ key, label, placeholder, type: 'textarea', ...extra });
const date = (key, label, extra = {}) => ({ key, label, type: 'date', ...extra });
const check = (key, label) => ({ key, label, type: 'checkbox' });
const select = (key, label, options, extra = {}) => ({ key, label, options, ...extra });

const peopleContext = async () => ({ people: await familyMemberNames() });
const person = (key = 'person', label = 'Family member') => select(
  key, label, ({ people }) => people, { placeholder: 'Choose a person', required: true },
);

const zoneOptions = [
  { value: 'America/New_York', label: 'Eastern time' },
  { value: 'America/Chicago', label: 'Central time' },
  { value: 'America/Denver', label: 'Mountain time' },
  { value: 'America/Los_Angeles', label: 'Pacific time' },
  { value: 'America/Anchorage', label: 'Alaska time' },
  { value: 'Pacific/Honolulu', label: 'Hawaii time' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Central Europe' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

const configs = {
  comments: {
    title: 'Comments', singular: 'Comment', icon: '🗨️',
    intro: 'Keep replies and family discussions together, with an optional link to the photo or post being discussed.',
    fields: [text('subject', 'Topic', 'What are you replying to?', { required: true }), text('contextLink', 'Photo or post link', 'Optional link'), area('body', 'Comment', 'Write your reply', { required: true })],
    cardTitle: 'subject', body: ['body'], meta: ['contextLink'],
  },
  voicenotes: {
    title: 'Voice & video notes', singular: 'Recorded note', icon: '🎙️',
    context: peopleContext,
    intro: 'Record or choose a short voice/video message. The file is uploaded into the family’s private shared Drive.',
    fields: [
      text('title', 'Title', 'A message for everyone', { required: true }),
      { key: 'recording', label: 'Recording', type: 'file', accept: 'audio/*,video/*', capture: 'user', hint: 'On a phone, choose the camera or recorder when prompted.' },
      person('forPerson', 'For'), area('note', 'Written note', 'Optional context'),
    ],
    toRecord: uploadVoiceNote,
    cardTitle: 'title', eyebrow: (r) => r.mimeType?.startsWith('video/') ? 'Video note' : 'Voice note', body: ['note'], meta: ['forPerson', 'mediaLink'],
  },
  checkin: {
    title: 'Daily check-in', singular: 'Check-in', icon: '👋', context: peopleContext,
    intro: 'A quick daily signal from each person—short enough to actually use.',
    fields: [person(), date('day', 'Day', { required: true, defaultValue: todayKey }), select('status', 'Status', ['I am good', 'Busy but okay', 'Could use a call', 'Need help'], { required: true, defaultValue: 'I am good' }), area('note', 'Note', 'Optional detail')],
    cardTitle: 'person', eyebrow: 'day', body: ['note'], badge: (r) => ({ label: r.status || 'Checked in', tone: /help|call/i.test(r.status) ? 'warn' : 'ok' }), sortField: 'day', soonest: false,
  },
  gratitude: {
    title: 'Highlights', singular: 'Highlight', icon: '✨', context: peopleContext,
    intro: 'Capture one good thing from the week so it does not disappear in the scroll.',
    fields: [person(), date('weekOf', 'Week of', { required: true, defaultValue: todayKey }), area('highlight', 'Good thing', 'What went well?', { required: true })],
    cardTitle: 'person', eyebrow: 'weekOf', body: ['highlight'], sortField: 'weekOf',
  },
  birthdays: {
    title: 'Birthdays & anniversaries', singular: 'Special date', icon: '🎂', context: peopleContext,
    intro: 'Keep important recurring dates and gift or celebration notes in one place.',
    fields: [text('name', 'Who or what?', 'Name', { required: true }), select('kind', 'Occasion', ['Birthday', 'Anniversary', 'Memorial', 'Other'], { required: true }), date('date', 'Date', { required: true }), text('reminder', 'Reminder plan', 'One week before'), area('notes', 'Notes', 'Gift ideas or traditions')],
    cardTitle: 'name', eyebrow: 'kind', body: ['notes'], meta: ['date', 'reminder'], sortField: 'date', soonest: true,
  },
  countdown: {
    title: 'Countdown', singular: 'Countdown', icon: '⏳',
    intro: 'See how long until the next visit, trip, celebration, or family milestone.',
    fields: [text('title', 'What are we counting down to?', 'Family reunion', { required: true }), date('targetDate', 'Date', { required: true }), text('location', 'Location', 'Optional'), area('notes', 'Notes')],
    cardTitle: 'title', body: ['notes'], meta: ['location'], badge: countdownBadge, sortField: 'targetDate', soonest: true,
  },
  visitplanner: {
    title: 'Visit planner', singular: 'Visit', icon: '🧳', context: peopleContext,
    intro: 'Coordinate who is hosting, who is travelling, and what still needs arranging.',
    fields: [text('title', 'Visit name', 'Thanksgiving visit', { required: true }), date('startDate', 'Arrive', { required: true }), date('endDate', 'Leave'), person('host', 'Host'), text('travellers', 'Travellers', 'Names separated by commas'), select('status', 'Status', ['Idea', 'Planning', 'Booked', 'Complete'], { defaultValue: 'Planning' }), area('notes', 'Plans and details')],
    cardTitle: 'title', eyebrow: 'status', body: ['notes'], meta: ['startDate', 'endDate', 'host', 'travellers'], sortField: 'startDate', soonest: true,
  },
  availability: {
    title: 'Availability', singular: 'Available time', icon: '🕓', context: peopleContext,
    intro: 'Share good windows for calls, visits, rides, and helping out.',
    fields: [person(), date('day', 'Day', { required: true }), text('from', 'From', '', { type: 'time', required: true }), text('to', 'To', '', { type: 'time', required: true }), select('forWhat', 'Good for', ['Call', 'Visit', 'Ride', 'Helping out', 'Anything']), area('notes', 'Notes')],
    cardTitle: 'person', eyebrow: 'forWhat', body: ['notes'], meta: ['day', 'from', 'to'], sortField: 'day', soonest: true,
  },
  timezones: {
    title: 'Time zones', singular: 'Time zone', icon: '🌍', context: peopleContext,
    intro: 'Keep everyone’s local time handy before calling.',
    fields: [person(), select('zone', 'Time zone', zoneOptions, { required: true }), text('city', 'City or label', 'Charlotte')],
    cardTitle: 'person', eyebrow: 'city', badge: timezoneBadge, meta: ['zone'],
  },
  vault: {
    title: 'Documents', singular: 'Document reference', icon: '🗂️',
    intro: 'Index important documents without putting passwords or full private numbers in the dashboard.',
    notice: () => safetyNotice('Store only a safe description and where the protected original lives. Never add passwords, full account numbers, or identity numbers.'),
    fields: [text('title', 'Document', 'Will, policy, deed…', { required: true }), select('category', 'Category', ['Legal', 'Insurance', 'Property', 'Identity', 'Tax', 'Medical', 'Other']), text('owner', 'Owner', 'Person or shared'), text('location', 'Protected location', 'Drive folder or filing cabinet', { required: true }), date('reviewDate', 'Review or renewal date'), area('notes', 'Safe notes')],
    cardTitle: 'title', eyebrow: 'category', body: ['notes'], meta: ['owner', 'location', 'reviewDate'],
  },
  inventory: {
    title: 'Home inventory', singular: 'Inventory item', icon: '🏠',
    intro: 'Record valuable household items and where their photos or receipts are stored.',
    fields: [text('item', 'Item', 'Living-room television', { required: true }), text('room', 'Room or location'), text('serial', 'Serial or model', 'Safe identifying reference'), date('purchaseDate', 'Purchased'), text('value', 'Approximate value', '$0.00'), text('photoLink', 'Photo or receipt link', 'Private Drive or Photos link', { type: 'url' }), area('notes', 'Notes')],
    cardTitle: 'item', eyebrow: 'room', body: ['notes'], meta: ['serial', 'purchaseDate', 'value', 'photoLink'],
  },
  notes: {
    title: 'Shared notes', singular: 'Note', icon: '📌',
    intro: 'Keep practical family information such as house instructions, bin day, and guest notes.',
    fields: [text('title', 'Title', 'Wi-Fi for guests', { required: true }), select('category', 'Category', ['Home', 'Travel', 'Contact', 'Instructions', 'Other']), area('body', 'Note', 'Write the useful details', { required: true, rows: 5 })],
    cardTitle: 'title', eyebrow: 'category', body: ['body'],
  },
  recipes: {
    title: 'Recipe box', singular: 'Recipe', icon: '🍲',
    intro: 'Preserve family recipes in a format everyone can cook from.',
    fields: [text('name', 'Recipe name', 'Grandma’s biscuits', { required: true }), select('category', 'Category', ['Breakfast', 'Main dish', 'Side', 'Dessert', 'Drink', 'Holiday', 'Other']), area('ingredients', 'Ingredients', 'One per line', { required: true, rows: 5 }), area('instructions', 'Instructions', 'Steps in order', { required: true, rows: 6 }), text('source', 'From', 'Person, cookbook, or link')],
    cardTitle: 'name', eyebrow: 'category', body: ['ingredients', 'instructions'], meta: ['source'],
  },
  stories: {
    title: 'Story archive', singular: 'Family story', icon: '📖', context: peopleContext,
    intro: 'Save family history in someone’s own words, with an optional private recording link.',
    fields: [text('title', 'Story title', 'The old house on Maple Street', { required: true }), text('storyteller', 'Told by', '', { required: true }), date('storyDate', 'When it happened'), text('mediaLink', 'Recording or photo link', 'Optional private link', { type: 'url' }), area('story', 'Story', 'Write or transcribe the memory', { required: true, rows: 7 })],
    cardTitle: 'title', eyebrow: 'storyteller', body: ['story'], meta: ['storyDate', 'mediaLink'],
  },
  oldphotos: {
    title: 'Old photos', singular: 'Old photo', icon: '🖼️',
    intro: 'Add context to scanned photographs so names and places are not lost.',
    fields: [text('title', 'Photo title', 'Family picnic', { required: true }), text('approximateDate', 'Approximate date', 'Summer 1968'), text('people', 'People pictured', 'Names separated by commas'), text('place', 'Place'), text('photoLink', 'Private photo link', 'Drive or Photos link', { type: 'url', required: true }), area('notes', 'Story or notes')],
    cardTitle: 'title', eyebrow: 'approximateDate', body: ['notes'], meta: ['people', 'place', 'photoLink'],
  },
  tree: {
    title: 'Family tree', singular: 'Relationship', icon: '🌳', context: peopleContext,
    intro: 'Build a simple relationship map one connection at a time.',
    fields: [text('person', 'Person', '', { required: true }), select('relation', 'Relationship', ['Parent of', 'Child of', 'Sibling of', 'Spouse or partner of', 'Grandparent of', 'Other'], { required: true }), text('relatedTo', 'Related to', '', { required: true }), date('born', 'Born'), date('died', 'Died'), area('notes', 'Notes')],
    cardTitle: 'person', eyebrow: 'relation', body: ['notes'], meta: ['relatedTo', 'born', 'died'],
  },
  grocery: {
    title: 'Shopping list', singular: 'Shopping item', icon: '🛒', context: peopleContext,
    intro: 'A shared list that anyone can update while they are at the store.',
    fields: [text('item', 'Item', 'Milk', { required: true }), text('quantity', 'Quantity', '1 gallon'), select('category', 'Aisle', ['Produce', 'Dairy', 'Meat', 'Pantry', 'Frozen', 'Household', 'Other']), text('assigned', 'Who is getting it?'), check('completed', 'Already bought')],
    cardTitle: 'item', eyebrow: 'category', meta: ['quantity', 'assigned'], badge: doneBadge,
  },
  meals: {
    title: 'Meal planning', singular: 'Meal', icon: '🍽️', context: peopleContext,
    intro: 'Plan meals, cooks, and useful preparation notes for the week.',
    fields: [date('day', 'Day', { required: true }), select('meal', 'Meal', ['Breakfast', 'Lunch', 'Dinner', 'Snack'], { required: true }), text('dish', 'What are we having?', '', { required: true }), text('cook', 'Who is cooking?'), area('notes', 'Preparation notes')],
    cardTitle: 'dish', eyebrow: 'meal', body: ['notes'], meta: ['day', 'cook'], sortField: 'day', soonest: true,
  },
  chores: {
    title: 'Chores', singular: 'Chore', icon: '🧹', context: peopleContext,
    intro: 'Assign household tasks and make completion visible.',
    fields: [text('task', 'Task', 'Take out recycling', { required: true }), text('assigned', 'Assigned to'), date('dueDate', 'Due'), select('recurrence', 'Repeats', ['Once', 'Daily', 'Weekly', 'Monthly', 'As needed']), check('completed', 'Completed'), area('notes', 'Notes')],
    cardTitle: 'task', body: ['notes'], meta: ['assigned', 'dueDate', 'recurrence'], badge: doneBadge, sortField: 'dueDate', soonest: true,
  },
  allowance: {
    title: 'Allowance', singular: 'Allowance entry', icon: '⭐', context: peopleContext,
    intro: 'Track points or pocket money earned from completed responsibilities.',
    fields: [text('child', 'Family member', '', { required: true }), text('reason', 'What was earned?', '', { required: true }), text('points', 'Points', '0', { type: 'number', min: '0' }), text('amount', 'Money', '0.00', { type: 'number', min: '0', step: '0.01' }), select('status', 'Status', ['Earned', 'Approved', 'Paid'], { defaultValue: 'Earned' }), area('notes', 'Notes')],
    cardTitle: 'reason', eyebrow: 'child', body: ['notes'], meta: ['points', 'amount'], badge: (r) => ({ label: r.status || 'Earned', tone: r.status === 'Paid' ? 'ok' : 'info' }),
  },
  maintenance: {
    title: 'Home upkeep', singular: 'Upkeep task', icon: '🔧',
    intro: 'Track maintenance before it becomes an emergency.',
    fields: [text('task', 'Task', 'Service heat pump', { required: true }), text('area', 'Area or appliance'), date('dueDate', 'Due date'), text('provider', 'Provider or contact'), text('cost', 'Estimated cost'), select('recurrence', 'Repeats', ['Once', 'Monthly', 'Quarterly', 'Twice yearly', 'Yearly']), check('completed', 'Completed'), area('notes', 'Notes')],
    cardTitle: 'task', eyebrow: 'area', body: ['notes'], meta: ['dueDate', 'provider', 'cost', 'recurrence'], badge: doneBadge, sortField: 'dueDate', soonest: true,
  },
  bucketlist: {
    title: 'Bucket list', singular: 'Bucket-list idea', icon: '🎯',
    intro: 'Save things the family wants to do together someday.',
    fields: [text('item', 'Idea', 'See the Grand Canyon', { required: true }), select('category', 'Category', ['Travel', 'Food', 'Outdoors', 'Learning', 'Celebration', 'Other']), text('who', 'Who wants to go?'), date('targetDate', 'Target date'), check('completed', 'We did it'), area('notes', 'Notes')],
    cardTitle: 'item', eyebrow: 'category', body: ['notes'], meta: ['who', 'targetDate'], badge: doneBadge,
  },
  watchlist: {
    title: 'Watchlist', singular: 'Watchlist item', icon: '🍿',
    intro: 'Keep films and shows the family wants to watch.',
    fields: [text('title', 'Title', '', { required: true }), select('kind', 'Type', ['Movie', 'Series', 'Documentary', 'Other']), text('platform', 'Where to watch', 'Netflix, library, cinema…'), text('suggestedBy', 'Suggested by'), check('completed', 'Watched'), area('notes', 'Notes')],
    cardTitle: 'title', eyebrow: 'kind', body: ['notes'], meta: ['platform', 'suggestedBy'], badge: (r) => ({ label: r.completed ? 'Watched' : 'To watch', tone: r.completed ? 'ok' : 'info' }),
  },
  reading: {
    title: 'Reading', singular: 'Book', icon: '📚',
    intro: 'Track books being recommended, read, or passed around.',
    fields: [text('title', 'Book title', '', { required: true }), text('author', 'Author'), text('holder', 'Who has it?'), select('status', 'Status', ['Want to read', 'Reading', 'Finished', 'Loaned'], { defaultValue: 'Want to read' }), area('notes', 'Notes')],
    cardTitle: 'title', eyebrow: 'author', body: ['notes'], meta: ['holder'], badge: (r) => ({ label: r.status || 'Want to read', tone: r.status === 'Finished' ? 'ok' : 'info' }),
  },
  playlists: {
    title: 'Playlists', singular: 'Playlist', icon: '🎵',
    intro: 'Share links to playlists everyone can add to or enjoy.',
    fields: [text('title', 'Playlist name', '', { required: true }), text('service', 'Music service', 'Spotify, Apple Music…'), text('link', 'Private or shared link', '', { type: 'url', required: true }), text('curator', 'Maintained by'), area('notes', 'Notes')],
    cardTitle: 'title', eyebrow: 'service', body: ['notes'], meta: ['curator', 'link'],
  },
  polls: {
    title: 'Polls', singular: 'Poll', icon: '🗳️',
    intro: 'Settle family decisions with one vote per signed-in person.',
    fields: [text('question', 'Question', 'Where should we meet?', { required: true }), area('choicesText', 'Choices', 'One choice per line', { required: true, rows: 5, fromRecord: (r) => (r.choices ?? []).join('\n') }), date('closes', 'Closes'), area('notes', 'Context')],
    toRecord: (values, editing) => {
      const choices = [...new Set(values.choicesText.split('\n').map((v) => cleanText(v, 120)).filter(Boolean))];
      if (choices.length < 2) return { error: 'Enter at least two choices, one per line.' };
      return { moduleKey: 'polls', question: cleanText(values.question, 300), choices, closes: values.closes, notes: cleanText(values.notes, 2000), votes: editing?.votes ?? {} };
    },
    cardTitle: 'question', body: ['notes'], metaView: pollResults, actions: pollActions,
  },
  wishlists: {
    title: 'Wish lists', singular: 'Wish-list item', icon: '🎁', context: peopleContext,
    intro: 'Keep gift ideas organized without spoiling private surprises.',
    fields: [text('item', 'Gift idea', '', { required: true }), text('person', 'For'), text('link', 'Product link', '', { type: 'url' }), text('price', 'Approximate price'), select('priority', 'Priority', ['Nice idea', 'Would love', 'Top choice']), check('completed', 'Already purchased'), area('notes', 'Size, color, or notes')],
    cardTitle: 'item', eyebrow: 'person', body: ['notes'], meta: ['price', 'link'], badge: (r) => ({ label: r.completed ? 'Purchased' : (r.priority || 'Idea'), tone: r.completed ? 'ok' : 'info' }),
  },
};

export const MORE_FEATURE_KEYS = Object.freeze(Object.keys(configs));

export function featureConfig(key) {
  return configs[key] ?? null;
}

export function moreFeatureView(key) {
  const config = configs[key];
  if (!config) throw new Error(`Unknown feature: ${key}`);

  const fields = config.fields;
  return collectionView({
    ...config,
    notice: typeof config.notice === 'function' ? config.notice() : config.notice,
    collection: RECORD_COLLECTIONS.familyItems,
    loadContext: config.context,
    emptyTitle: `No ${config.title.toLowerCase()} yet`,
    emptyMessage: `Use “Add ${config.singular.toLowerCase()}” to get started.`,
    addLabel: `Add ${config.singular.toLowerCase()}`,
    query: { where: [['moduleKey', '==', key]], limit: 500 },
    sort: config.soonest ? sortSoonest(config.sortField) : sortNewest(config.sortField ?? 'updatedAt'),
    toRecord: config.toRecord ?? ((values) => ({ moduleKey: key, ...cleanValues(values, fields) })),
    renderCard: (record) => recordCard(record[config.cardTitle] || config.title, {
      eyebrow: valueOf(config.eyebrow, record),
      meta: config.metaView ? config.metaView(record) : (config.meta ?? []).map((field) => displayValue(field, record[field])).filter(Boolean),
      body: (config.body ?? []).map((field) => record[field]).filter(Boolean).join('\n\n'),
      badge: config.badge?.(record) ?? null,
    }),
    actions: config.actions,
    deletePrompt: (record) => `Delete “${record[config.cardTitle] || config.singular}”?`,
  });
}

function cleanValues(values, fields) {
  const out = {};
  for (const field of fields) {
    out[field.key] = field.type === 'checkbox' ? Boolean(values[field.key]) : cleanText(values[field.key], field.maxlength ?? 4000);
  }
  return out;
}

function valueOf(field, record) {
  if (typeof field === 'function') return field(record);
  return field ? record[field] : null;
}

function displayValue(field, value) {
  if (value == null || value === '') return '';
  if (/date|day|born|died|closes/i.test(field) && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return formatDate(`${value}T12:00:00`);
  }
  if (/link/i.test(field)) return `Link: ${value}`;
  if (field === 'amount') return `$${Number(value || 0).toFixed(2)}`;
  if (field === 'points') return `${value} points`;
  if (field === 'from' || field === 'to') return `${field === 'from' ? 'From' : 'to'} ${value}`;
  return String(value);
}

function doneBadge(record) {
  return { label: record.completed ? 'Done' : 'Open', tone: record.completed ? 'ok' : 'info' };
}

function countdownBadge(record) {
  const target = new Date(`${record.targetDate}T12:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const days = Math.ceil((target - new Date()) / 86_400_000);
  if (days < 0) return { label: 'Passed', tone: 'neutral' };
  if (days === 0) return { label: 'Today', tone: 'ok' };
  return { label: `${days} day${days === 1 ? '' : 's'}`, tone: 'info' };
}

function timezoneBadge(record) {
  try {
    return { label: new Intl.DateTimeFormat(undefined, { timeZone: record.zone, hour: 'numeric', minute: '2-digit' }).format(new Date()), tone: 'info' };
  } catch { return null; }
}

function pollResults(record) {
  const totals = Object.values(record.votes ?? {}).reduce((map, choice) => {
    map[choice] = (map[choice] ?? 0) + 1;
    return map;
  }, {});
  return (record.choices ?? []).map((choice) => `${choice}: ${totals[choice] ?? 0}`);
}

function pollActions(record) {
  const uid = state.user?.uid;
  const chosen = record.votes?.[uid];
  return (record.choices ?? []).map((choice) => el('button', {
    class: `btn btn--small${chosen === choice ? ' btn--primary' : ''}`,
    type: 'button', onClick: async () => {
      try {
        await saveRecord(RECORD_COLLECTIONS.familyItems, record.id, {
          votes: { ...(record.votes ?? {}), [uid]: choice },
        });
        toast(`Voted for ${choice}`);
      } catch { toast('Could not save your vote', { error: true }); }
    },
  }, chosen === choice ? `✓ ${choice}` : choice));
}

function safetyNotice(message) {
  return el('div', { class: 'card record-notice' },
    el('strong', {}, 'Keep private secrets protected'),
    el('p', { class: 'small' }, message));
}

async function uploadVoiceNote(values, editing) {
  const file = values.recording;
  if (!editing && !file) return { error: 'Record or choose an audio or video file first.' };

  let media = editing ? {
    driveFileId: editing.driveFileId, mediaLink: editing.mediaLink,
    mimeType: editing.mimeType, fileName: editing.fileName,
  } : {};
  if (file) {
    if (!/^audio\//.test(file.type) && !/^video\//.test(file.type)) {
      return { error: 'Choose an audio or video recording.' };
    }
    toast('Uploading the recording to the shared Drive…', { duration: 8000 });
    const uploaded = await uploadFile(file, {
      folderId: state.config.driveFolderId,
      clientId: state.config.googleClientId,
      path: ['Dashboard_Document_Storage', 'Voice and video notes', String(new Date().getFullYear())],
    });
    media = {
      driveFileId: uploaded.id,
      mediaLink: `https://drive.google.com/file/d/${uploaded.id}/view`,
      mimeType: uploaded.mimeType || file.type,
      fileName: uploaded.name || file.name,
    };
  }

  return {
    moduleKey: 'voicenotes', title: cleanText(values.title, 200),
    forPerson: cleanText(values.forPerson, 120), note: cleanText(values.note, 2000),
    ...media,
  };
}
