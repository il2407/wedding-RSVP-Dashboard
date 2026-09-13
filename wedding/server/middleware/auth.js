const { query } = require('../db');

const COOKIE_NAME = 'sid';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function setSessionCookie(res, userId) {
  res.cookie(COOKIE_NAME, String(userId), {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function getUserIdFromReq(req) {
  const raw = req.signedCookies && req.signedCookies[COOKIE_NAME];
  const userId = parseInt(raw, 10);
  return Number.isInteger(userId) ? userId : null;
}

function requireAuth(req, res, next) {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  req.userId = userId;
  next();
}

function requireAuthPage(req, res, next) {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.redirect('/login/');
  req.userId = userId;
  next();
}

async function requireOnboarded(req, res, next) {
  try {
    const { rows } = await query('SELECT couple_name_1, couple_name_2 FROM settings WHERE user_id = $1', [req.userId]);
    const settings = rows[0];
    const onboarded = settings && settings.couple_name_1.trim() && settings.couple_name_2.trim();
    if (!onboarded) return res.redirect('/onboarding/');
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  setSessionCookie,
  clearSessionCookie,
  getUserIdFromReq,
  requireAuth,
  requireAuthPage,
  requireOnboarded,
};
