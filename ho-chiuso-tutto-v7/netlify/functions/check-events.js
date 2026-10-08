// Netlify Scheduled Function - runs every minute
// Checks Firebase RTDB for events due NOW and sends FCM push notifications

const admin = require('firebase-admin');

// Initialize Firebase Admin only once
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://calendario-e26e8-default-rtdb.firebaseio.com'
  });
}

const db = admin.database();
const messaging = admin.messaging();

// Get current date/time in Europe/Rome timezone
function getRomeTime() {
  const now = new Date();
  const rome = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  return {
    year: rome.getFullYear(),
    month: rome.getMonth(), // 0-based
    date: rome.getDate(),
    day: rome.getDay(), // 0=Sun
    hours: rome.getHours(),
    minutes: rome.getMinutes(),
    dateStr: `${rome.getFullYear()}-${String(rome.getMonth() + 1).padStart(2, '0')}-${String(rome.getDate()).padStart(2, '0')}`,
    timeStr: `${String(rome.getHours()).padStart(2, '0')}:${String(rome.getMinutes()).padStart(2, '0')}`
  };
}

// Check if an event matches today
function eventMatchesToday(ev, rome) {
  if (!ev || !ev.type) return false;

  if (ev.type === 'once') {
    return ev.date === rome.dateStr;
  }

  if (ev.type === 'daily') {
    return true;
  }

  if (ev.type === 'weekly') {
    // ev.days is array of day indices [0-6], 0=Sun
    if (ev.days && Array.isArray(ev.days)) {
      return ev.days.includes(rome.day);
    }
    return false;
  }

  if (ev.type === 'monthly') {
    return ev.dayOfMonth === rome.date;
  }

  if (ev.type === 'yearly') {
    return ev.monthOfYear === (rome.month + 1) && ev.dayOfMonth === rome.date;
  }

  return false;
}

exports.handler = async function(event, context) {
  try {
    const rome = getRomeTime();
    console.log(`[check-events] Running at Rome time: ${rome.dateStr} ${rome.timeStr}`);

    // Read all events
    const eventsSnap = await db.ref('/events').once('value');
    const events = eventsSnap.val();

    if (!events) {
      console.log('[check-events] No events found');
      return { statusCode: 200, body: 'No events' };
    }

    // Find events due NOW (matching time exactly)
    const dueEvents = [];
    const preEvents = []; // 5 minutes before

    for (const [id, ev] of Object.entries(events)) {
      if (!eventMatchesToday(ev, rome)) continue;

      if (ev.time === rome.timeStr) {
        dueEvents.push(ev);
      }

      // Check 5 min before reminder
      if (ev.time) {
        const [h, m] = ev.time.split(':').map(Number);
        let preH = h, preM = m - 5;
        if (preM < 0) { preM += 60; preH--; }
        if (preH < 0) preH = 23;
        const preTime = `${String(preH).padStart(2, '0')}:${String(preM).padStart(2, '0')}`;
        if (preTime === rome.timeStr) {
          preEvents.push(ev);
        }
      }
    }

    if (dueEvents.length === 0 && preEvents.length === 0) {
      console.log('[check-events] No due events at this time');
      return { statusCode: 200, body: 'No due events' };
    }

    // Get all registered FCM tokens
    const tokensSnap = await db.ref('/tokens').once('value');
    const tokensData = tokensSnap.val();

    if (!tokensData) {
      console.log('[check-events] No tokens registered');
      return { statusCode: 200, body: 'No tokens' };
    }

    const tokens = Object.values(tokensData).map(t => typeof t === 'string' ? t : t.token).filter(Boolean);

    if (tokens.length === 0) {
      console.log('[check-events] No valid tokens');
      return { statusCode: 200, body: 'No valid tokens' };
    }

    console.log(`[check-events] Found ${dueEvents.length} due events, ${preEvents.length} pre-events, ${tokens.length} tokens`);

    // Send notifications
    const messages = [];

    for (const ev of dueEvents) {
      messages.push({
        title: `${ev.emoji || '📅'} ${ev.title}`,
        body: `Adesso! (${ev.time})`
      });
    }

    for (const ev of preEvents) {
      messages.push({
        title: `${ev.emoji || '📅'} ${ev.title}`,
        body: `Tra 5 minuti (${ev.time})`
      });
    }

    // Send each message to all tokens
    const results = [];
    const invalidTokens = [];

    for (const msg of messages) {
      for (const token of tokens) {
        try {
          await messaging.send({
            token: token,
            data: {
              title: msg.title,
              body: msg.body
            },
            webpush: {
              headers: {
                Urgency: 'high',
                TTL: '300'
              },
              notification: {
                title: msg.title,
                body: msg.body,
                icon: './icon-192.png',
                badge: './icon-192.png',
                vibrate: [300, 100, 300, 100, 300],
                requireInteraction: true,
                tag: `hct-server-${Date.now()}`
              }
            }
          });
          results.push({ success: true, token: token.substring(0, 10) + '...' });
        } catch (err) {
          console.error(`[check-events] FCM send error:`, err.code || err.message);
          results.push({ success: false, error: err.code });
          // Track invalid tokens for cleanup
          if (err.code === 'messaging/invalid-registration-token' ||
              err.code === 'messaging/registration-token-not-registered') {
            invalidTokens.push(token);
          }
        }
      }
    }

    // Clean up invalid tokens
    if (invalidTokens.length > 0) {
      const allTokenEntries = tokensSnap.val();
      for (const [key, val] of Object.entries(allTokenEntries)) {
        const storedToken = typeof val === 'string' ? val : val.token;
        if (invalidTokens.includes(storedToken)) {
          await db.ref(`/tokens/${key}`).remove();
          console.log(`[check-events] Removed invalid token: ${key}`);
        }
      }
    }

    console.log(`[check-events] Results:`, JSON.stringify(results));

    return {
      statusCode: 200,
      body: JSON.stringify({
        time: rome.timeStr,
        dueEvents: dueEvents.length,
        preEvents: preEvents.length,
        sent: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
      })
    };

  } catch (error) {
    console.error('[check-events] Error:', error);
    return { statusCode: 500, body: error.message };
  }
};

// Netlify scheduled function config
exports.config = {
  schedule: '* * * * *'
};
