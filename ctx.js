// 请求作用域：用 AsyncLocalStorage 传递"当前是哪个用户/什么作用域"，
// 让 db / bookshelf / interview 在底层自动选对文件，业务代码无需到处传参。
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

// scope: { scope: 'user'|'shared', uid, isOwner }
function runWith(scope, fn) {
  return als.run(scope, fn);
}

function currentScope() {
  return als.getStore() || { scope: 'shared', uid: null, isOwner: false };
}

function currentUid() {
  const s = currentScope();
  return s.scope === 'user' ? s.uid : null;
}

function isSharedScope() {
  return currentScope().scope === 'shared';
}

module.exports = { runWith, currentScope, currentUid, isSharedScope };
