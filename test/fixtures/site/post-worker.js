// Dedicated Worker：在 worker 里发一条 POST，把状态码回给页面。
fetch('/api/worker', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
  .then((r) => postMessage(r.status), () => postMessage('err'));
