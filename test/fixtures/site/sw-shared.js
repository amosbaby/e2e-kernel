// SharedWorker 脚本：页面一连上就往写端点 POST（路由看不到这条请求）。
onconnect = function () {
  fetch('/api/sink?case=shared-worker', { method: 'POST', body: 'x' }).catch(function () {});
};
