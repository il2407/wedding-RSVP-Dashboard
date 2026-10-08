// Express 4 never catches a rejected promise from an async route handler: the rejection goes
// unhandled, and on Node 22 that terminates the whole process — so a single malformed public
// request (e.g. guests="abc" hitting an integer column) used to take the server down for every
// account. Patching Layer makes every route/middleware forward a rejected promise to next(err)
// so it reaches errorHandler below. This is the same technique as express-async-errors.
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncErrorsPatched) {
  const originalHandle = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return originalHandle.call(this, req, res, next); // error handlers
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === 'function') result.catch(next);
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__asyncErrorsPatched = true;
}

// Postgres errors caused by bad client input rather than a server fault: invalid text
// representation (e.g. 'abc' into an integer) and numeric value out of range.
const PG_BAD_INPUT_CODES = new Set(['22P02', '22003']);

// Route params that must be a positive integer id; anything else is simply not found.
function requireNumericParam(req, res, next, value) {
  if (!/^\d{1,9}$/.test(String(value))) return res.status(404).json({ error: 'Not found' });
  next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // body-parser errors (malformed JSON, payload too large) carry their own 4xx status.
  if (err.status && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.expose ? err.message : 'Bad request' });
  }
  if (PG_BAD_INPUT_CODES.has(err.code)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  console.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler, requireNumericParam };
