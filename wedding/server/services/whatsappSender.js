const { query } = require('../db');

// undefined = not checked yet, false = checked and missing, client = ready to use.
let twilioClient;

function getTwilioClient() {
  if (twilioClient !== undefined) return twilioClient;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    twilioClient = false;
    return false;
  }
  twilioClient = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return twilioClient;
}

// Guest phone numbers are stored as typed (e.g. 0501234567); Twilio needs full E.164
// (e.g. 972501234567), same conversion the manual wa.me tool does client-side.
function toE164Digits(phone, countryCode) {
  const digits = String(phone).replace(/\D/g, '');
  const cc = String(countryCode || '').replace(/\D/g, '');
  if (cc && digits.startsWith(cc)) return digits;
  return `${cc}${digits.replace(/^0+/, '')}`;
}

const SEND_DELAY_MS = 1200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processJob(job) {
  const client = getTwilioClient();
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM;

  if (!client || !fromNumber) {
    console.error(
      `WhatsApp job ${job.id} is due but Twilio isn't configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM in the server .env — it will be picked up automatically on the next check.`
    );
    return;
  }

  const { rows: settingsRows } = await query('SELECT whatsapp_country_code FROM settings WHERE user_id = $1', [job.user_id]);
  const settings = settingsRows[0];
  const countryCode = settings ? settings.whatsapp_country_code : '';

  await query("UPDATE whatsapp_jobs SET status = 'sending' WHERE id = $1", [job.id]);

  const { rows: recipients } = await query(
    "SELECT * FROM whatsapp_job_recipients WHERE job_id = $1 AND status = 'pending'",
    [job.id]
  );

  for (const recipient of recipients) {
    try {
      await client.messages.create({
        from: `whatsapp:${fromNumber}`,
        to: `whatsapp:+${toE164Digits(recipient.phone, countryCode)}`,
        body: recipient.message,
      });
      await query(
        "UPDATE whatsapp_job_recipients SET status = 'sent', sent_at = $1 WHERE id = $2",
        [new Date().toISOString(), recipient.id]
      );
    } catch (err) {
      await query(
        "UPDATE whatsapp_job_recipients SET status = 'failed', error = $1 WHERE id = $2",
        [err.message, recipient.id]
      );
    }
    await sleep(SEND_DELAY_MS);
  }

  await query("UPDATE whatsapp_jobs SET status = 'completed' WHERE id = $1", [job.id]);
}

let isRunning = false;

// Picks up jobs whose scheduled time has arrived, plus any still stuck in 'sending' from a
// server restart mid-job (processJob only re-sends recipients still marked 'pending', so
// this is safe to re-run without double-sending anyone who already succeeded or failed).
async function runDueJobs() {
  if (isRunning) return;
  isRunning = true;
  try {
    const { rows: dueJobs } = await query(
      "SELECT * FROM whatsapp_jobs WHERE status IN ('pending', 'sending') AND scheduled_at <= $1",
      [new Date().toISOString()]
    );

    for (const job of dueJobs) {
      await processJob(job);
    }
  } finally {
    isRunning = false;
  }
}

function startScheduler() {
  runDueJobs();
  setInterval(runDueJobs, 30 * 1000);
}

module.exports = { startScheduler, runDueJobs };
