const express = require('express');
const path    = require('path');
const { requireAuth, requireRole } = require('../middleware/auth');
const router  = express.Router();

const view = name => path.join(__dirname, '../views', name);

router.get('/',               (req, res) => res.redirect(req.session.userId ? '/lpr' : '/login'));
router.get('/login',          (req, res) => req.session.userId ? res.redirect('/lpr') : res.sendFile(view('login.html')));
router.get('/2fa',            (req, res) => req.session.pendingAuth   ? res.sendFile(view('2fa.html'))       : res.redirect('/login'));
router.get('/setup-2fa',      (req, res) => req.session.pendingSetup  ? res.sendFile(view('setup-2fa.html')) : res.redirect('/login'));
router.get('/forgot-password',(req, res) => res.sendFile(view('forgot-password.html')));
router.get('/reset-password', (req, res) => res.sendFile(view('reset-password.html')));
router.get('/lpr',            requireAuth,                       (req, res) => res.sendFile(view('lpr.html')));
router.get('/account',        requireAuth,                       (req, res) => res.sendFile(view('account.html')));
router.get('/users',                requireRole('admin', 'manager'), (req, res) => res.sendFile(view('users.html')));
router.get('/users/:id/locations',  requireRole('admin', 'manager'), (req, res) => res.sendFile(view('user-locations.html')));
router.get('/bolo',                 requireRole('admin', 'manager'), (req, res) => res.sendFile(view('bolo.html')));

module.exports = router;
