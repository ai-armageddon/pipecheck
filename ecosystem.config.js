// PM2 process definitions for PipeCheck.
//
//   pm2 start ecosystem.config.js
//   pm2 logs pipecheck-api
//   pm2 restart pipecheck-api
//
// The frontend is served as a static production build. After changing anything
// under frontend/src, rebuild and restart:
//
//   cd frontend && CI=false npx react-scripts build && pm2 restart pipecheck-web
//
// Both processes bind to 127.0.0.1. The API has no authentication, so do not
// expose it on 0.0.0.0 without putting auth in front of it.
module.exports = {
  apps: [
    {
      name: 'pipecheck-api',
      cwd: './backend',
      // Python 3.11/3.12 venv; pandas/pydantic pins have no wheels for 3.13+.
      script: './.venv/bin/python',
      args: '-m uvicorn app.main:app --host 127.0.0.1 --port 8001',
      interpreter: 'none',
      env: {
        DATABASE_URL: 'sqlite:///./pipecheck.db',
        CORS_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
        PYTHONUNBUFFERED: '1',
      },
      autorestart: true,
      max_restarts: 10,
      // SQLite plus in-process WebSocket state: a single worker only.
      instances: 1,
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'pipecheck-web',
      cwd: './frontend',
      // pm2's bundled static file server - no extra dependency needed.
      script: 'serve',
      env: {
        PM2_SERVE_HOST: '127.0.0.1',
        PM2_SERVE_PATH: './build',
        PM2_SERVE_PORT: '3000',
        PM2_SERVE_SPA: 'true',
        PM2_SERVE_HOMEPAGE: '/index.html',
      },
      autorestart: true,
      instances: 1,
      error_file: './logs/web-error.log',
      out_file: './logs/web-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
