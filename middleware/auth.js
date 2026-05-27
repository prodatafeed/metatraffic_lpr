const INACTIVITY = 15 * 60; // seconds

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return req.accepts('html')
      ? res.redirect('/login?reason=auth')
      : res.status(401).json({ error: 'Unauthorized' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (req.session.lastActivity && now - req.session.lastActivity > INACTIVITY) {
    const email = req.session.userEmail;
    req.session.destroy(() => {});
    return req.accepts('html')
      ? res.redirect('/login?reason=timeout')
      : res.status(401).json({ error: 'Session expired due to inactivity' });
  }
  req.session.lastActivity = now;
  next();
}

function requireRole(...roles) {
  return [requireAuth, (req, res, next) => {
    if (!roles.includes(req.session.userRole)) {
      return req.accepts('html')
        ? res.status(403).send('<h2>403 Forbidden</h2><p>You do not have permission to view this page.</p><a href="/lpr">Back</a>')
        : res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }];
}

module.exports = { requireAuth, requireRole };
