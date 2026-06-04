const fs = require('fs');
const path = require('path');

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return env;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        return env;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (key) {
        env[key] = value;
      }
      return env;
    }, {});
}

const fileEnv = readEnvFile(path.join(__dirname, '.env'));

module.exports = {
  apps: [
    {
      name: 'mapdr-api',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '3G',
      env: {
        ...fileEnv,
        NODE_ENV: 'development',
        PORT: 3001,
      },
      env_production: {
        ...fileEnv,
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
  ],
};
