const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const OpenAI = require('openai');

admin.initializeApp();
setGlobalOptions({ maxInstances: 5 });

const openaiApiKey = defineSecret('OPENAI_API_KEY');
const googleClientSecret = defineSecret('GOOGLE_CLIENT_SECRET');

// Same public value as GOOGLE_CLIENT_ID in viro/firebase-config.js - the client ID isn't a
// secret (it just identifies the app to Google), so it's hardcoded here rather than requiring
// another `firebase functions:secrets:set` step.
const GOOGLE_CLIENT_ID = '688963596071-s758lk93ekbl21n394j2l0g99qiovt8j.apps.googleusercontent.com';

const MODEL = 'gpt-4o-mini';
const MAX_INPUT_CHARS = 12000; // keeps requests (and cost) bounded

/**
 * Single callable entry point for every AI feature in the portal. Firebase
 * verifies the caller's auth token before this ever runs, so no manual
 * token-checking is needed - `request.auth` is only populated for signed-in
 * users of THIS Firebase project.
 *
 * request.data: { task, text, context }
 * - continue | improve | grammar | format  -> notes editor (text = note content/selection)
 * - describe_file                           -> Files tab (text = filename, context = { imageUrl? })
 * - smart_search                            -> Files/Drive/Contacts/Overview (text = query,
 *                                              context = { items: [{id, type, title, subtitle, date}] })
 * - smart_command                           -> Overview search+add bar (text = free-form instruction,
 *                                              context = { today: 'YYYY-MM-DD' })
 * - calendar_summary                        -> Calendar tab + Overview (context = { events: [{title, start, end}] })
 *
 * Google Calendar connect/refresh/disconnect are separate callables below (googleCalendarConnect,
 * googleCalendarToken, googleCalendarDisconnect) since they don't need the OpenAI key at all.
 */
exports.aiAssist = onCall({ secrets: [openaiApiKey], cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const { task, text, context } = request.data || {};
  if (!task || typeof task !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing task.');
  }

  const openai = new OpenAI({ apiKey: openaiApiKey.value() });
  const input = String(text || '').slice(0, MAX_INPUT_CHARS);

  try {
    switch (task) {
      case 'continue':
        return { result: await runText(openai, {
          system: 'You continue notes for a student. Read the note below and write the next 1-3 sentences that would naturally follow, in the same tone and tense. Return ONLY the continuation text - no preamble, no quotes, no repeating what was already written.',
          user: input
        }) };

      case 'improve':
        return { result: await runText(openai, {
          system: 'Rewrite the following note text so it reads more clearly and naturally, keeping the same meaning, facts, and roughly the same length. Return ONLY the rewritten text, no preamble.',
          user: input
        }) };

      case 'grammar':
        return { result: await runText(openai, {
          system: 'Fix spelling and grammar mistakes in the following text. Do not change the meaning, wording style, or add/remove content beyond correcting errors. Return ONLY the corrected text, no preamble.',
          user: input
        }) };

      case 'format':
        return { result: await runText(openai, {
          system: 'Reformat the following note into clear, well-structured HTML using only these tags: <p>, <ul>, <ol>, <li>, <strong>, <em>, <u>, <h3>. Add headings and bullet/numbered lists where it genuinely helps a student review the material. Keep all the original information - do not summarize or remove content. Return ONLY the HTML, no code fences, no preamble.',
          user: input
        }) };

      case 'describe_file':
        return { result: await describeFile(openai, input, context) };

      case 'smart_search':
        return { result: await smartSearch(openai, input, context) };

      case 'smart_command':
        return { result: await smartCommand(openai, input, context) };

      case 'calendar_summary':
        return { result: await calendarSummary(openai, context) };

      default:
        throw new HttpsError('invalid-argument', `Unknown task: ${task}`);
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error('aiAssist error', err);
    throw new HttpsError('internal', 'AI request failed.');
  }
});

async function runText(openai, { system, user }) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.6,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });
  return (completion.choices[0]?.message?.content || '').trim();
}

async function describeFile(openai, fileName, context) {
  const imageUrl = context?.imageUrl;
  const system =
    'Write ONE short, plain sentence (under 18 words) describing what this file likely is, for a personal file organizer. No preamble, no quotes, just the sentence.';

  if (imageUrl) {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Filename: ${fileName}` },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ]
    });
    return (completion.choices[0]?.message?.content || '').trim();
  }

  // Non-image files: best guess from the filename alone (no content extraction).
  return runText(openai, {
    system,
    user: `Filename: ${fileName}`
  });
}

async function smartSearch(openai, query, context) {
  const items = Array.isArray(context?.items) ? context.items : [];
  if (!items.length || !query.trim()) return { ids: [] };

  const listing = items
    .map(
      (it) =>
        `id: ${it.id} | type: ${it.type || 'item'} | title: ${it.title} | detail: ${it.subtitle || '(none)'} | date: ${it.date || 'unknown'}`
    )
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You match a natural-language search query against a list of personal items (id, type, title, detail, date) from a private organizer app. Return JSON like {"ids": ["id1", "id2"]} listing the ids of items that plausibly match the query, best match first. Consider dates loosely (e.g. "march 2023" matches items from around then) and match across type/title/detail. If nothing matches reasonably, return {"ids": []}. Only output the JSON object.'
      },
      { role: 'user', content: `Query: ${query}\n\nItems:\n${listing}` }
    ]
  });

  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
    return { ids: Array.isArray(parsed.ids) ? parsed.ids : [] };
  } catch (err) {
    console.error('smart_search parse error', err);
    return { ids: [] };
  }
}

async function smartCommand(openai, text, context) {
  const today = context?.today || new Date().toISOString().slice(0, 10);

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are the command parser for the search bar of a personal organizer app. Given one short instruction from the user, decide whether they want to ADD a new item (a to-do, a birthday, a contact, or a calendar event) or SEARCH for something that already exists.

Today's date is ${today} (YYYY-MM-DD). Resolve relative dates ("tomorrow", "tmrw", "next friday", "in 3 days") against it.

Return ONLY a JSON object in exactly one of these shapes:
- To-do: {"intent":"add","type":"todo","todo":{"title":"...","list":"school"|"personal"|"business","deadline":"YYYY-MM-DD"|null}}
- Birthday: {"intent":"add","type":"birthday","birthday":{"name":"...","date":"YYYY-MM-DD"}}
- Contact: {"intent":"add","type":"contact","contact":{"name":"...","phone":"","email":""}}
- Event: {"intent":"add","type":"event","event":{"title":"...","date":"YYYY-MM-DD","time":"HH:MM"|null,"durationMinutes":60,"location":""}}
- Search: {"intent":"search","query":"..."} (query = the instruction cleaned up for keyword search)
- Can't tell: {"intent":"unclear"}

Only choose "add" when the instruction clearly describes something new to create. Choose "event" (not "todo") when there's a specific time, or it names a person/place/activity you'd put on a calendar (dinner, meeting, hangout, appointment, class) - choose "todo" for plain tasks/chores with no specific meeting time. Default a to-do's "list" to "personal" unless school or work/business is clearly implied. For events, leave "time" null only for genuinely all-day/no-time-mentioned events, and pick a sensible "durationMinutes" from context (30 for a quick call, 60 as a safe default, longer for things like trips or parties). Leave fields you're unsure about as empty strings (or null). Output nothing but the JSON object - no preamble, no code fences.`
      },
      { role: 'user', content: text }
    ]
  });

  try {
    return JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch (err) {
    console.error('smart_command parse error', err);
    return { intent: 'unclear' };
  }
}

async function calendarSummary(openai, context) {
  const events = Array.isArray(context?.events) ? context.events : [];
  if (!events.length) return 'Nothing on your calendar today — enjoy the open day.';

  const listing = events
    .map((e) => `- ${e.title}${e.start ? ` (${e.start}${e.end ? `-${e.end}` : ''})` : ' (all day)'}`)
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.5,
    messages: [
      {
        role: 'system',
        content:
          'You summarize someone\'s day from their calendar events in ONE short, casual sentence, the way a friend would say it out loud - e.g. "You have 3 classes, 2 meetings, and a hangout with a friend today." Group similar events sensibly (classes, meetings, hangouts/social, appointments, etc.) using your judgment from the titles - do not just list every title. Return ONLY that one sentence, no preamble, no quotes.'
      },
      { role: 'user', content: `Today's events:\n${listing}` }
    ]
  });
  return (completion.choices[0]?.message?.content || '').trim();
}

/* ==================== Google Calendar OAuth ====================
 * Google's refresh tokens are long-lived - equivalent to a standing credential - so unlike the
 * short-lived access token, they're never sent to the client. These three callables are the only
 * things that ever read/write it, via the Admin SDK straight to Firestore (which bypasses the
 * client-facing security rules, and the client never queries this path either way). The client
 * calls googleCalendarToken to get a short-lived access token, then talks to the Google Calendar
 * REST API directly with that token - only the refresh step needs to be server-side.
 */

async function exchangeGoogleCode(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: googleClientSecret.value(),
      redirect_uri: redirectUri || 'postmessage',
      grant_type: 'authorization_code'
    })
  });
  return { ok: res.ok, data: await res.json() };
}

exports.googleCalendarConnect = onCall({ secrets: [googleClientSecret], cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { code, redirectUri } = request.data || {};
  if (!code) throw new HttpsError('invalid-argument', 'Missing authorization code.');

  const { ok, data } = await exchangeGoogleCode(code, redirectUri);
  if (!ok || !data.refresh_token) {
    console.error('Google token exchange failed', data);
    throw new HttpsError('internal', 'Could not connect to Google Calendar. Try again.');
  }

  let email = '';
  try {
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` }
    });
    email = (await infoRes.json()).email || '';
  } catch (err) {
    console.error('Google userinfo lookup failed', err);
  }

  const uid = request.auth.uid;
  const batch = admin.firestore().batch();
  batch.set(admin.firestore().doc(`users/${uid}/googleCalendar/connection`), {
    refreshToken: data.refresh_token,
    email,
    connectedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  // Client-readable companion doc with no token in it, so the UI can show connection
  // status via a normal Firestore listener without ever touching the sensitive doc above.
  batch.set(admin.firestore().doc(`users/${uid}/googleCalendar/status`), { connected: true, email });
  await batch.commit();

  return { email };
});

exports.googleCalendarToken = onCall({ secrets: [googleClientSecret], cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

  const ref = admin.firestore().doc(`users/${request.auth.uid}/googleCalendar/connection`);
  const snap = await ref.get();
  const refreshToken = snap.data()?.refreshToken;
  if (!refreshToken) {
    throw new HttpsError('failed-precondition', 'Google Calendar is not connected.');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: googleClientSecret.value(),
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    console.error('Google token refresh failed', data);
    throw new HttpsError('internal', 'Could not refresh Google Calendar access. Try reconnecting.');
  }

  return { accessToken: data.access_token, expiresIn: data.expires_in, email: snap.data().email || '' };
});

exports.googleCalendarDisconnect = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

  const uid = request.auth.uid;
  const ref = admin.firestore().doc(`users/${uid}/googleCalendar/connection`);
  const snap = await ref.get();
  const refreshToken = snap.data()?.refreshToken;

  if (refreshToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' });
    } catch (err) {
      console.error('Google token revoke failed', err);
    }
  }

  const batch = admin.firestore().batch();
  batch.delete(ref);
  batch.delete(admin.firestore().doc(`users/${uid}/googleCalendar/status`));
  await batch.commit();

  return { ok: true };
});
