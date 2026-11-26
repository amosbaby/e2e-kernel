// Shared by frames.html and frame-child.html. Every action POSTs to this page's own origin
// at /api/sink?case=<label>-<kind>. The label comes from ?label=, else from <body data-label>.
const label = new URLSearchParams(location.search).get('label') ?? document.body.dataset.label ?? 'none';

function sinkUrl(kind) {
  return '/api/sink?' + new URLSearchParams({ case: label + '-' + kind });
}

document.getElementById('do-fetch').addEventListener('click', () => {
  fetch(sinkUrl('fetch'), { method: 'POST' }).catch(() => {});
});

document.getElementById('do-xhr').addEventListener('click', () => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', sinkUrl('xhr'));
  xhr.send();
});

document.getElementById('do-beacon').addEventListener('click', () => {
  navigator.sendBeacon(sinkUrl('beacon'));
});

document.getElementById('sink-form').action = sinkUrl('form');
