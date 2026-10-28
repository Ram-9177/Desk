// pm2: `pm2 start ecosystem.config.cjs`. Exactly one process: the email queue, rate limits and settings cache live in memory.
module.exports = {
  apps: [{
    name: 'one-desk',
    script: 'server.js',
    cwd: __dirname,
    node_args: '--no-warnings --env-file-if-exists=.env',
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: '400M', // t3.micro has 1 GB shared with Postgres and nginx
    kill_timeout: 10000, // the server needs up to 8 s to finish requests and close the pool on SIGTERM
    time: true,
  }],
};
