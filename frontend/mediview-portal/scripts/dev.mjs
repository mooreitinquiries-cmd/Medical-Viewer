import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';

const children = [];
let shuttingDown = false;
const AUTH_API_PORT = Number(process.env.AUTH_API_PORT || 8788);

function startProcess(name, command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    for (const currentChild of children) {
      if (currentChild.pid && !currentChild.killed) {
        currentChild.kill('SIGTERM');
      }
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });

  child.on('error', (error) => {
    console.error(`[dev] Failed to start ${name}:`, error);

    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    for (const currentChild of children) {
      if (currentChild.pid && !currentChild.killed) {
        currentChild.kill('SIGTERM');
      }
    }

    process.exit(1);
  });

  return child;
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (child.pid && !child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (child.pid && !child.killed) {
        child.kill('SIGKILL');
      }
    }
  }, 3_000).unref();

  process.exit(signal === 'SIGINT' ? 130 : 0);
}

function canConnect({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      resolve(false);
    });

    socket.setTimeout(750, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function isPortInUse(port) {
  const hosts = ['127.0.0.1', '::1'];

  for (const host of hosts) {
    if (await canConnect({ host, port })) {
      return true;
    }
  }

  return false;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (await isPortInUse(AUTH_API_PORT)) {
  console.log(
    `[dev] auth-api port ${AUTH_API_PORT} is already in use; reusing the existing auth service.`
  );
} else {
  startProcess('auth-api', process.execPath, ['server/auth-api/server.mjs']);
}

startProcess('vite', process.execPath, ['node_modules/vite/bin/vite.js']);
