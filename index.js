const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- SAFE MODE MOCKS ---
const config = {
  PORT: 4000,
  WHATSAPP_TIMEOUT_MS: 20000,
  DEFAULT_PUSH_TIMEOUT_MS: 20000
};

const sign = (payload) => {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
};

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- STORES ---
const TELEMETRY = {};
const USER_EVENTS = {};
const EVENT_ORDER = [];

// 1. NEW: MOCK USER DATABASE (Stores registered Device IDs)
const USER_DB = {
  'demo_user': {
    registered_device_id: 'device_888', // The "Old" trusted device ID
    is_registered: true
  }
};

// 2. SIMULATOR CONTEXT (Overrides)
const DEVICE_CONTEXT_STORE = {
  'demo_user': {
    device_status: 'KNOWN', // 'KNOWN' or 'NEW'
    has_app: true,
    is_active: false,
    device_online: true,
    whatsapp_opt_in: true
  }
};

function now() { return new Date().toISOString(); }

function pushUserEvent(userId, eventId) {
  if (!USER_EVENTS[userId]) USER_EVENTS[userId] = [];
  USER_EVENTS[userId].push(eventId);
}

function recordLog(event_id, msg) {
  if (!TELEMETRY[event_id]) return;
  TELEMETRY[event_id].logs.push({ ts: now(), msg });
  console.log(`[event ${event_id}] ${msg}`);
}

app.get('/health', (req, res) => res.json({ ok: true, ts: now() }));

// --- UPDATE CONTEXT (Called by login.html) ---
app.post('/update-context', (req, res) => {
  try {
    const { user_id, context } = req.body;
    const targetUser = user_id || 'demo_user';
    
    DEVICE_CONTEXT_STORE[targetUser] = {
      ...DEVICE_CONTEXT_STORE[targetUser],
      ...context
    };
    
    // console.log(`[Simulator] Context updated:`, DEVICE_CONTEXT_STORE[targetUser]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// NEW: LOGIN & DEVICE IDENTITY LOGIC
// ==========================================

app.post('/login', (req, res) => {
  const { user_id, device_id } = req.body;
  const event_id = uuidv4();
  
  // 1. Get Simulator Context
  const simContext = DEVICE_CONTEXT_STORE[user_id] || {};
  
  // 2. Init Telemetry
  TELEMETRY[event_id] = {
    event_id, user_id, 
    event_type: 'LOGIN_ATTEMPT',
    chosen_channel: 'ANALYZING', 
    sent_ts: now(), ack_ts: null,
    fallback_triggered: false, fallback_channel: null, logs: []
  };
  if (!EVENT_ORDER.includes(event_id)) EVENT_ORDER.unshift(event_id);
  pushUserEvent(user_id, event_id);

  recordLog(event_id, `Login attempt from Device ID: ${device_id}`);

  // 3. DECISION TREE (Based on Simulator Toggle)
  
  if (simContext.device_status === 'KNOWN') {
    // --- SCENARIO A: TRUSTED DEVICE ---
    TELEMETRY[event_id].event_type = 'TRUSTED_LOGIN';
    TELEMETRY[event_id].chosen_channel = 'IN_APP';
    
    recordLog(event_id, `✅ Device ID matched registry.`);
    recordLog(event_id, `Trust Score: HIGH. Sending In-App Flash.`);
    
    return res.json({
      status: 'TRUSTED',
      event_id,
      channel: 'IN_APP',
      message: 'Device Verified.'
    });

  } else {
    // --- SCENARIO B: NEW DEVICE (BINDING) ---
    TELEMETRY[event_id].event_type = 'NEW_DEVICE_LOGIN';
    TELEMETRY[event_id].chosen_channel = 'SMS_BINDING';
    
    recordLog(event_id, `⚠️ Device ID mismatch (Unknown Device).`);
    recordLog(event_id, `Security Policy: Force SIM Binding (Upstream SMS).`);
    
    return res.json({
      status: 'BINDING_REQUIRED',
      event_id,
      channel: 'SMS_BINDING',
      target_number: '+919999999999', // Simulating Bank VMN
      message: 'Binding Required.'
    });
  }
});

// NEW: CALLED BY APP AFTER SENDING BINDING SMS
app.post('/complete-binding', (req, res) => {
  const { user_id, device_id, event_id } = req.body;
  
  // Update Mock DB
  const oldID = USER_DB[user_id]?.registered_device_id || 'none';
  USER_DB[user_id] = { registered_device_id: device_id, is_registered: true };

  // Update Telemetry
  if (event_id && TELEMETRY[event_id]) {
    TELEMETRY[event_id].ack_ts = now(); // Mark flow as complete
    recordLog(event_id, `📩 Encrypted SMS received at Bank Server.`);
    recordLog(event_id, `♻️ Registry Updated: Replaced ${oldID} with ${device_id}.`);
  }

  res.json({ ok: true });
});

// ==========================================
// ORIGINAL: TRANSACTION ROUTING (Unchanged)
// ==========================================
app.post('/send-notification', (req, res) => {
  try {
    const body = req.body || {};
    const event_id = body.event_id || uuidv4();
    const user_id = body.user_id || 'demo_user';
    const event_type = body.event_type || 'LOGIN_OTP';
    
    const simulatedContext = DEVICE_CONTEXT_STORE[user_id] || {};
    const ctx = { ...body.user_context, ...simulatedContext };

    console.log(`[Transaction] User: ${user_id} | Context:`, JSON.stringify(ctx));

    TELEMETRY[event_id] = {
      event_id, user_id, event_type,
      chosen_channel: null, sent_ts: null, ack_ts: null,
      fallback_triggered: false, fallback_channel: null, logs: [],
    };
    
    if (!EVENT_ORDER.includes(event_id)) EVENT_ORDER.unshift(event_id);
    pushUserEvent(user_id, event_id);

    // A) IN_APP
    if (ctx.has_app && ctx.is_active && ctx.device_online) {
      TELEMETRY[event_id].chosen_channel = 'IN_APP';
      TELEMETRY[event_id].sent_ts = now();
      recordLog(event_id, 'Route: IN_APP (User active in app)');
      return res.json({ event_id, chosen_channel: 'IN_APP', telemetry: TELEMETRY[event_id] });
    }

    // B) PUSH
    if (ctx.has_app && ctx.device_online) {
      TELEMETRY[event_id].chosen_channel = 'PUSH';
      TELEMETRY[event_id].sent_ts = now();
      recordLog(event_id, 'Route: PUSH (Background notification)');

      setTimeout(() => {
        if (!TELEMETRY[event_id] || TELEMETRY[event_id].ack_ts) return;
        const fallback = ctx.whatsapp_opt_in ? 'WHATSAPP' : 'SMS';
        TELEMETRY[event_id].fallback_triggered = true;
        TELEMETRY[event_id].fallback_channel = fallback;
        recordLog(event_id, `No ACK -> Fallback to ${fallback}`);
      }, config.WHATSAPP_TIMEOUT_MS);

      return res.json({ event_id, chosen_channel: 'PUSH', telemetry: TELEMETRY[event_id] });
    }

    // C) WHATSAPP
    if (ctx.whatsapp_opt_in && ctx.device_online) {
      TELEMETRY[event_id].chosen_channel = 'WHATSAPP';
      TELEMETRY[event_id].sent_ts = now();
      recordLog(event_id, 'Route: WHATSAPP (Opt-in Primary)');
      
      setTimeout(() => {
        if (!TELEMETRY[event_id] || TELEMETRY[event_id].ack_ts) return;
        TELEMETRY[event_id].fallback_triggered = true;
        TELEMETRY[event_id].fallback_channel = 'SMS';
        recordLog(event_id, 'No ACK -> Fallback to SMS');
      }, config.WHATSAPP_TIMEOUT_MS);

      return res.json({ event_id, chosen_channel: 'WHATSAPP', telemetry: TELEMETRY[event_id] });
    }

    // D) SMS
    TELEMETRY[event_id].chosen_channel = 'SMS';
    TELEMETRY[event_id].sent_ts = now();
    recordLog(event_id, 'Route: SMS (Last Resort)');
    return res.json({ event_id, chosen_channel: 'SMS', telemetry: TELEMETRY[event_id] });

  } catch (error) {
    console.error("ERROR:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// --- COMMON: ACK ENDPOINT ---
app.post('/ack', (req, res) => {
  const { event_id, channel } = req.body || {};
  if (TELEMETRY[event_id]) {
    TELEMETRY[event_id].ack_ts = now();
    recordLog(event_id, `ACK received via ${channel}`);
  }
  res.json({ ok: true });
});

// --- DASHBOARD DATA ---
app.get('/events', (req, res) => {
  const limit = 50;
  const events = EVENT_ORDER.slice(0, limit).map(id => TELEMETRY[id]).filter(Boolean);
  res.json({ count: events.length, events });
});
// --- NEW: SECURE INBOX ENDPOINT ---
app.get('/inbox/:userId', (req, res) => {
  const userId = req.params.userId;
  const eventIds = USER_EVENTS[userId] || [];
  
  // Get full details for these events, sorted newest first
  const messages = eventIds
    .map(id => TELEMETRY[id])
    .filter(evt => evt) // remove nulls
    .reverse(); // Newest on top

  res.json({ messages });
});
// --- START SERVER ---
app.listen(config.PORT, () => {
  console.log(`\n🚀 TrustSync Backend running on port ${config.PORT}`);
  console.log(`\n---------------------------------------------------------`);
  console.log(`🏠 Home (Start Here):      http://localhost:${config.PORT}/home.html`);
  console.log(`---------------------------------------------------------\n`);
});