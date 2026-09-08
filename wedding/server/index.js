require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { requireAuthPage, requireOnboarded } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const legacyRoutes = require('./routes/legacy');
const configRoutes = require('./routes/config');
const invitedGuestsRoutes = require('./routes/invitedGuests');
const rsvpRoutes = require('./routes/rsvps');
const busRegistrationRoutes = require('./routes/busRegistrations');
const mediaRoutes = require('./routes/media');
const whatsappRoutes = require('./routes/whatsapp');
const { startScheduler } = require('./services/whatsappSender');

const app = express();
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET));

app.use('/api', authRoutes);
app.use('/api', legacyRoutes);
app.use('/api', configRoutes);
app.use('/api', invitedGuestsRoutes);
app.use('/api', rsvpRoutes);
app.use('/api', busRegistrationRoutes);
app.use('/api', whatsappRoutes);
app.use(mediaRoutes);

const weddingRoot = path.join(__dirname, '..');

app.use('/assets', express.static(path.join(weddingRoot, 'assets')));
app.use('/rsvp-form', express.static(path.join(weddingRoot, 'rsvp-form')));
app.use('/bus-approval', express.static(path.join(weddingRoot, 'bus-approval')));
app.use('/login', express.static(path.join(weddingRoot, 'login')));
app.use('/signup', express.static(path.join(weddingRoot, 'signup')));
app.use('/onboarding', requireAuthPage, express.static(path.join(weddingRoot, 'onboarding')));
app.use('/dashboard', requireAuthPage, requireOnboarded, express.static(path.join(weddingRoot, 'dashboard')));
app.use('/bulk-messaging', requireAuthPage, requireOnboarded, express.static(path.join(weddingRoot, 'bulk-messaging')));
app.use('/admin', requireAuthPage, requireOnboarded, express.static(path.join(weddingRoot, 'admin')));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Wedding platform server listening on http://localhost:${port}`);
});

startScheduler();
