const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const OpenAI = require('openai');

setGlobalOptions({ maxInstances: 5 });

const openaiApiKey = defineSecret('OPENAI_API_KEY');

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
        content: `You are the command parser for the search bar of a personal organizer app. Given one short instruction from the user, decide whether they want to ADD a new item (a to-do, a birthday, or a contact) or SEARCH for something that already exists.

Today's date is ${today} (YYYY-MM-DD). Resolve relative dates ("tomorrow", "tmrw", "next friday", "in 3 days") against it.

Return ONLY a JSON object in exactly one of these shapes:
- To-do: {"intent":"add","type":"todo","todo":{"title":"...","list":"school"|"personal"|"business","deadline":"YYYY-MM-DD"|null}}
- Birthday: {"intent":"add","type":"birthday","birthday":{"name":"...","date":"YYYY-MM-DD"}}
- Contact: {"intent":"add","type":"contact","contact":{"name":"...","phone":"","email":""}}
- Search: {"intent":"search","query":"..."} (query = the instruction cleaned up for keyword search)
- Can't tell: {"intent":"unclear"}

Only choose "add" when the instruction clearly describes a new to-do/birthday/contact to create. Default a to-do's "list" to "personal" unless school or work/business is clearly implied. Leave fields you're unsure about as empty strings (or null for deadline). Output nothing but the JSON object - no preamble, no code fences.`
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
