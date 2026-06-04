const http = require('http');
const https = require('https');

const baseUrl = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');

function getStatus(url) {
  return new Promise(function (resolve, reject) {
    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, function (res) {
      resolve(res.statusCode || 0);
      res.resume();
    });
    req.on('error', reject);
    req.setTimeout(10000, function () {
      req.destroy(new Error('Request timeout'));
    });
  });
}

async function run() {
  const checks = [
    ['/api/health', [200, 503]],
    ['/api/ready', [200, 503]],
    ['/api/studies', [200]],
  ];

  let failed = false;

  for (const [path, allowed] of checks) {
    const url = `${baseUrl}${path}`;
    try {
      const status = await getStatus(url);
      const ok = allowed.includes(status);
      console.log(`${ok ? 'OK' : 'FAIL'} ${path} -> ${status}`);
      if (!ok) failed = true;
    } catch (err) {
      failed = true;
      console.log(`FAIL ${path} -> ${err.message}`);
    }
  }

  if (failed) {
    process.exit(1);
  }
}

run();
