/**
 * PM2 Ecosystem File — for StackHost / production deployment.
 *
 * This config ensures the seo-utilities-api runs as a persistent,
 * auto-restarting service with proper log rotation and memory limits.
 *
 * StackHost setup:
 *   1. Upload this project (or git push)
 *   2. StackHost runs: npm install && npm run build
 *   3. StackHost starts via: pm2 start ecosystem.config.cjs
 *
 * Memory note (StackHost 512MB RAM):
 *   - max_memory_restart: 400M — restart before OOM killer kicks in
 *   - Adaptive concurrency: MUFFET_MAX_CONCURRENCY=5 (base) / MUFFET_BOOST_CONCURRENCY=10 (boost)
 *   - MUFFET_MAX_QUEUE_SIZE=200 — safety valve
 *   - MUFFET_BOOST_THRESHOLD=50 — switches between boost and base
 */

module.exports = {
  apps: [
    {
      name: 'seo-utilities-api',
      script: './dist/server.js',
      node_args: '--max-old-space-size=384',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      kill_timeout: 10000,
      listen_timeout: 15000,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: 10000,
    },
  ],
};
