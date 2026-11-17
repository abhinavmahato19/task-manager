const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const CLOUDANT_URL = (process.env.CLOUDANT_URL || '').replace(/\/+$/, '');
const CLOUDANT_APIKEY = process.env.CLOUDANT_APIKEY;
const DB_NAME = process.env.CLOUDANT_DB || 'glasstask';
const PRIORITIES = new Set(['low', 'medium', 'high']);

if (!CLOUDANT_URL || !CLOUDANT_APIKEY) {
  console.error('Set CLOUDANT_URL and CLOUDANT_APIKEY in .env.');
  process.exit(1);
}

// IBM Cloud IAM: trade the API key for a bearer token (lasts about an hour)
let cachedToken = null;
let tokenExpiresAt = 0; // milliseconds

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: CLOUDANT_APIKEY,
    }),
  });
  if (!res.ok) {
    throw new Error(`IAM token request failed (HTTP ${res.status}). Check CLOUDANT_APIKEY.`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = data.expiration * 1000;
  return cachedToken;
}

// Send a request to the Cloudant HTTP API
async function couch(method, urlPath, body) {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${CLOUDANT_URL}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.reason || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

const docPath = (id) => `/${DB_NAME}/${encodeURIComponent(id)}`;

function toTask(doc) {
  return {
    id: doc._id,
    text: doc.text,
    dueDate: doc.dueDate || '',
    priority: doc.priority,
    completed: Boolean(doc.completed),
    createdAt: doc.createdAt || null,
  };
}

// Cloudant IDs can't start with an underscore (those are reserved for system docs)
function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

function fail(res, err, fallback) {
  if (err.status === 404) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }
  if (err.status === 409) {
    res.status(409).json({ error: 'Conflict: the task changed or already exists. Refresh and try again.' });
    return;
  }
  console.error(err.message || err);
  res.status(500).json({ error: fallback });
}

async function ensureDatabase() {
  try {
    await couch('PUT', `/${DB_NAME}`);
    console.log(`Created Cloudant database "${DB_NAME}".`);
  } catch (err) {
    if (err.status !== 412) throw err; // 412 means it already exists
  }
}

const app = express();
app.use(express.json({ limit: '10kb' }));

// GET all tasks
app.get('/api/tasks', async (req, res) => {
  try {
    const data = await couch('GET', `/${DB_NAME}/_all_docs?include_docs=true`);
    const tasks = data.rows
      .map((row) => row.doc)
      .filter((doc) => doc && !doc._id.startsWith('_design/'))
      .map(toTask)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    res.json(tasks);
  } catch (err) {
    fail(res, err, 'Could not load tasks.');
  }
});

// CREATE a task
app.post('/api/tasks', async (req, res) => {
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const priority = body.priority || 'medium';
  const dueDate = typeof body.dueDate === 'string' ? body.dueDate : '';

  if (!text || text.length > 500) {
    return res.status(400).json({ error: 'Task text is required (max 500 characters).' });
  }
  if (!PRIORITIES.has(priority)) {
    return res.status(400).json({ error: 'Priority must be low, medium, or high.' });
  }
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return res.status(400).json({ error: 'Due date must be YYYY-MM-DD.' });
  }

  const id = validId(body.id) ? body.id : crypto.randomUUID();
  const createdAt =
    typeof body.createdAt === 'string' && body.createdAt ? body.createdAt : new Date().toISOString();

  const doc = {
    _id: id,
    text,
    dueDate,
    priority,
    completed: Boolean(body.completed),
    createdAt,
  };

  try {
    await couch('PUT', docPath(id), doc);
    res.status(201).json(toTask(doc));
  } catch (err) {
    fail(res, err, 'Could not save the task.');
  }
});

// TOGGLE (no body) or SET ({ "completed": true|false }) a task
app.patch('/api/tasks/:id', async (req, res) => {
  const id = req.params.id;
  if (!validId(id)) {
    return res.status(400).json({ error: 'Invalid task id.' });
  }

  const setCompleted = typeof (req.body || {}).completed === 'boolean' ? req.body.completed : null;

  // Cloudant has no atomic update operator, so read the document, change it,
  // and write it back with its _rev. On a conflict (409), read it again and retry.
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const doc = await couch('GET', docPath(id));
      doc.completed = setCompleted !== null ? setCompleted : !doc.completed;

      try {
        await couch('PUT', docPath(id), doc);
        return res.json(toTask(doc));
      } catch (err) {
        if (err.status !== 409 || attempt === 3) throw err;
      }
    }
  } catch (err) {
    fail(res, err, 'Could not update the task.');
  }
});

// DELETE a task
app.delete('/api/tasks/:id', async (req, res) => {
  const id = req.params.id;
  if (!validId(id)) {
    return res.status(400).json({ error: 'Invalid task id.' });
  }
  try {
    const doc = await couch('GET', docPath(id));
    await couch('DELETE', `${docPath(id)}?rev=${encodeURIComponent(doc._rev)}`);
    res.status(204).end();
  } catch (err) {
    fail(res, err, 'Could not delete the task.');
  }
});

// Serve only the public folder
app.use(express.static(path.join(__dirname, 'public')));

async function start() {
  try {
    await ensureDatabase(); // also confirms the URL and API key work
    app.listen(PORT, () => {
      console.log(`GlassTask is running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Could not connect to Cloudant. Check CLOUDANT_URL and CLOUDANT_APIKEY in .env.');
    console.error(err.message);
    process.exit(1);
  }
}

start();