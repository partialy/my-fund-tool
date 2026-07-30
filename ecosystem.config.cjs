module.exports = {
  apps: [
    {
      name: 'fund-sim-tool',
      script: 'src/server.js',
      cwd: '/www/wwwroot/node-service/fund-sim-tool',
      interpreter: '/usr/bin/node',
      node_args: '--experimental-sqlite',
      time: true,
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: '53999',
        FUND_SIM_DB_PATH: '/www/wwwroot/node-service/fund-sim-tool/data/fund-sim.sqlite',
      },
    },
  ],
};
