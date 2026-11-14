const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ensureChrome, getChromeLaunchArgs } = require('./chrome');

test('builds visible Chrome arguments for the local debug endpoint', () => {
  assert.deepEqual(
    getChromeLaunchArgs('http://localhost:9333', 'C:\\Users\\Mox\\chrome profile'),
    [
      '--remote-debugging-port=9333',
      '--user-data-dir=C:\\Users\\Mox\\chrome profile',
      'https://www.moxfield.com/',
    ]
  );
});

test('does not auto-launch Chrome for a remote debug endpoint', () => {
  assert.throws(
    () => getChromeLaunchArgs('http://192.168.1.10:9222'),
    /non-local CHROME_URL/
  );
});

test('reuses an existing local debugging endpoint', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Browser: 'Chrome', webSocketDebuggerUrl: 'ws://localhost/devtools' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const status = await ensureChrome(`http://127.0.0.1:${port}`);
    assert.equal(status.up, true);
    assert.equal(status.browser, 'Chrome');
    assert.equal(status.started, false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
