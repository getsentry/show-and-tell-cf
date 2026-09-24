// jsdom has dialog elements but does not implement the native modal lifecycle.
// Focus trapping, inert backgrounds, Escape, and focus restoration are browser checks.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
